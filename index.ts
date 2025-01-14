import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as hcloud from "@pulumi/hcloud";
import * as command from "@pulumi/command";
import * as cloudflare from "@pulumi/cloudflare";

const config = new pulumi.Config();
const domain = config.require("domain");
const adminEmail = config.require("admin_email");

// Hetzner configuration
const server = new hcloud.Server("mail-server", {
    name: "mail-server",
    serverType: "cpx11",
    image: "ubuntu-22.04",
    location: "nbg1",
    sshKeys: ["mail-server-key"],
    labels: {
        environment: "production",
        service: "mail",
    },
});

// AWS SES setup
const sesIdentity = new aws.ses.DomainIdentity("domain-identity", {
    domain: domain,
});

const sesDkim = new aws.ses.DomainDkim("domain-dkim", {
    domain: domain,
});

// DNS records for SES verification
const dkimRecords = sesDkim.dkimTokens.apply((tokens) =>
    tokens.map((token, index) => ({
        name: `${token}._domainkey.${domain}`,
        type: "CNAME",
        value: `${token}.dkim.amazonses.com`,
    }))
);

// Create SMTP credentials
const iamUser = new aws.iam.User("ses-smtp-user", {
    name: "ses-smtp-user",
});

const iamAccessKey = new aws.iam.AccessKey("ses-smtp-key", {
    user: iamUser.name,
});

// Policy for SES domain verification and DKIM
const sesVerificationPolicy = new aws.iam.UserPolicy("ses-verification-policy", {
    user: "kindchess-admin", // Your existing IAM user
    policy: {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "ses:VerifyDomainIdentity",
                    "ses:VerifyDomainDkim",
                    "ses:GetIdentityVerificationAttributes",
                    "ses:GetIdentityDkimAttributes",
                    "ses:DeleteIdentity",
                    "ses:SendRawEmail",
                ],
                Resource: "*",
            },
        ],
    },
});

// Original SMTP policy for the new IAM user
const iamPolicy = new aws.iam.UserPolicy("ses-smtp-policy", {
    user: iamUser.name,
    policy: {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: "ses:SendRawEmail",
                Resource: "*",
            },
        ],
    },
});

// Server setup script
const setupScript = new command.local.Command("setup-script", {
    create: pulumi.interpolate`
        ssh root@${server.ipv4Address} 'bash -c "
        # Wait for cloud-init to complete
        while [ ! -f /var/lib/cloud/instance/boot-finished ]; do
            echo Waiting for cloud-init...
            sleep 1
        done

        # Install Docker and Docker Compose
        apt-get update && apt-get install -y docker.io docker-compose

        # Create parent directory with proper permissions
        mkdir -p /data
        chmod 755 /data

        # Create directories
        mkdir -p /data/mailu/{certs,data,dkim,mail,mailqueue,filter,webmail,overrides}
        mkdir -p /data/radicale
        chmod -R 755 /data/mailu
        chmod -R 755 /data/radicale

        # Verify directories were created
        ls -la /data/mailu
        ls -la /data/radicale

        # Generate secret key
        SECRET_KEY=\$(openssl rand -base64 32)

        # Create environment file
        cat > /data/mailu.env << EOL
        DOMAIN=${domain}
        HOSTNAME=mail.${domain}
        SECRET_KEY=\$SECRET_KEY
        SUBNET=192.168.203.0/24
        ENABLE_SIGNUP=False
        ADMIN=${adminEmail}
        MESSAGE_SIZE_LIMIT=50000000
        POSTMASTER=admin
        RELAYHOST=email-smtp.us-east-1.amazonaws.com:587
        RELAYUSER=${iamAccessKey.id}
        RELAYPASSWORD=${iamAccessKey.sesSmtpPasswordV4}
        RELAYTLS=yes
        EOL

        # Verify env file was created
        ls -la /data/mailu.env
        "'
    `,
    triggers: [server.ipv4Address],
});

// In index.ts, modify the compose configuration like this:
const deployCompose = new command.local.Command("deploy-compose", {
    create: pulumi.interpolate`
        # Add a small delay to ensure setup is complete
        sleep 5
        
        ssh root@${server.ipv4Address} 'bash -c "
        # Verify directories exist before proceeding
        if [ ! -d /data ]; then
            echo Directory /data does not exist
            exit 1
        fi

        # Save docker-compose config
        cat > /data/docker-compose.yml << 'EOL'
        # ... rest of your docker-compose config ...

        # Verify docker-compose file was created
        ls -la /data/docker-compose.yml

        # Start the containers
        cd /data && docker-compose up -d
        "'
    `,
    triggers: [server.ipv4Address],
});
const zoneId = config.require("cloudflare_zone_id");


// Create A record for mail subdomain
const aRecord = new cloudflare.Record("mail-a-record", {
    zoneId: zoneId,
    name: "mail",
    type: "A",
    content: server.ipv4Address,
    ttl: 3600,
    proxied: false,  // Direct connection needed for mail server
    allowOverwrite: false,  // Don't try to manage if record already exists
});

// Create MX record
const mxRecord = new cloudflare.Record("mx-record", {
    zoneId: zoneId,
    name: domain,
    type: "MX",
    content: `mail.${domain}`,
    priority: 10,
    ttl: 3600,
    allowOverwrite: false,  // Don't try to manage if record already exists
});

// Create SPF record
const spfRecord = new cloudflare.Record("spf-record", {
    zoneId: zoneId,
    name: domain,
    type: "TXT",
    content: "v=spf1 include:amazonses.com ~all",
    ttl: 3600,
    allowOverwrite: false,  // Don't try to manage if record already exists
});

// Create DMARC record
const dmarcRecord = new cloudflare.Record("dmarc-record", {
    zoneId: zoneId,
    name: "_dmarc",
    type: "TXT",
    content: `v=DMARC1; p=none; rua=mailto:${config.require("admin_email")}`,
    ttl: 3600,
    allowOverwrite: false,  // Don't try to manage if record already exists
});

// Create DKIM records
sesDkim.dkimTokens.apply(tokens => {
    tokens.forEach((token, index) => {
        new cloudflare.Record(`dkim-record-${index}`, {
            zoneId: zoneId,
            name: `${token}._domainkey`,
            type: "CNAME",
            content: `${token}.dkim.amazonses.com`,
            ttl: 3600,
            allowOverwrite: false,  // Don't try to manage if record already exists
        });
    });
});

// Add reverse PTR record hint for the Hetzner server
const ptrHintRecord = new cloudflare.Record("ptr-hint", {
    zoneId: zoneId,
    name: "mail",
    type: "TXT",
    content: pulumi.interpolate`v=ptr server=${server.ipv4Address}`,
    ttl: 3600,
    allowOverwrite: false,  // Don't try to manage if record already exists
});
// Export important values
export const serverIp = server.ipv4Address;
export const smtpUsername = iamAccessKey.id;
export const smtpPassword = iamAccessKey.sesSmtpPasswordV4;
export const dkimDnsRecords = dkimRecords;
