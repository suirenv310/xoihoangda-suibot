const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

const GUILD_ID = '1517042905846513746';
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('clientReady', async () => {
    const guild = await client.guilds.fetch(GUILD_ID);
    const sayonara = guild.roles.cache.find(r => r.name === 'sayonara');
    if (!sayonara) { console.log('No sayonara role found.'); process.exit(0); }
    console.log('sayonara role id:', sayonara.id, '| members:', sayonara.members.size);

    const members = await guild.members.fetch();
    let removed = 0;
    for (const [id, m] of members) {
        if (m.roles.cache.has(sayonara.id)) {
            console.log(`REMOVE sayonara from ${m.user.tag} (${id})`);
            try {
                await m.roles.remove(sayonara, 'SLTĐ cleanup — stale sayonara role');
                removed++;
            } catch (e) {
                console.log(`  FAIL:`, e.message);
            }
        }
    }
    console.log('=== Summary: removed sayonara from', removed, 'members ===');
    process.exit(0);
});
client.login(process.env.BOT_TOKEN);
