const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

const GUILD_ID = '1517042905846513746';
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
    const guild = await client.guilds.fetch(GUILD_ID);
    if (!guild) { console.error('Guild not found or bot not in it'); process.exit(1); }
    const channels = await guild.channels.fetch();
    for (const [id, ch] of channels) {
        if (ch.isTextBased()) {
            const overwrites = ch.permissionOverwrites.cache.size;
            console.log(`#${ch.name} | id=${id} | overwrites=${overwrites}`);
        }
    }
    process.exit(0);
});
client.login(process.env.BOT_TOKEN);
