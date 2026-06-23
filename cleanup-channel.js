const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
require('dotenv').config();

const CHANNEL_ID = process.argv[2];
if (!CHANNEL_ID) { console.error('Usage: node cleanup-channel.js <channelId>'); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
client.config = { text: { error: 'err' }, colors: {} };

client.once('clientReady', async () => {
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        if (!channel) { console.error('Channel not found'); process.exit(1); }
        const guild = channel.guild;

        console.log('=== Channel:', channel.name, '|', channel.id, '===');
        console.log('Guild:', guild.name, '|', guild.id);
        console.log('');

        const overwrites = channel.permissionOverwrites.cache;
        console.log('Total permission overwrites:', overwrites.size);
        console.log('');

        let deleted = 0, skipped = 0, failed = 0;
        for (const [id, overwrite] of overwrites) {
            // skip @everyone and the guild's own perms
            if (id === guild.id) { console.log('SKIP @everyone'); skipped++; continue; }
            const target = await guild.members.fetch(id).catch(() => null)
                || await guild.roles.fetch(id).catch(() => null);
            const name = target ? (target.user?.tag || target.name) : '???';
            const allowBits = new PermissionsBitField(overwrite.allow.bitfield).toArray();
            const denyBits = new PermissionsBitField(overwrite.deny.bitfield).toArray();
            console.log(`DEL id=${id} name=${name} | allow=[${allowBits.join(',')}] deny=[${denyBits.join(',')}]`);
            try {
                await overwrite.delete('SLTĐ cleanup — stale game permission');
                console.log('  -> deleted');
                deleted++;
            } catch (e) {
                console.log('  -> FAIL:', e.message);
                failed++;
            }
        }

        console.log('');
        console.log('=== Summary ===');
        console.log('Deleted:', deleted, '| Skipped:', skipped, '| Failed:', failed);
    } catch (e) {
        console.error('Fatal:', e.message);
    }
    process.exit(0);
});

client.login(process.env.BOT_TOKEN);
