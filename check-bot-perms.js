const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
require('dotenv').config();

const GUILD_ID = '1517042905846513746';
const CHANNEL_ID = '1517548683346837594';
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('clientReady', async () => {
    const guild = await client.guilds.fetch(GUILD_ID);
    const me = await guild.members.fetchMe();
    const channel = await client.channels.fetch(CHANNEL_ID);

    console.log('=== Bot role ===');
    console.log('  id:', me.roles.botRole?.id);
    console.log('  name:', me.roles.botRole?.name);

    console.log('');
    console.log('=== Bot permissions in GUILD ===');
    const guildPerms = me.permissions;
    const guildPermArr = guildPerms.toArray();
    console.log('  ', guildPermArr.sort().join(', '));

    console.log('');
    console.log('=== Bot permissions in CHANNEL ===');
    const chanPerms = channel.permissionsFor(me);
    const chanPermArr = chanPerms ? chanPerms.toArray() : ['none'];
    console.log('  ', chanPermArr.sort().join(', '));

    console.log('');
    console.log('=== Required to delete overwrite ===');
    console.log('  ManageChannels (guild-level required to delete on channel)');
    console.log('  ManageRoles (sometimes required)');

    process.exit(0);
});
client.login(process.env.BOT_TOKEN);
