require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('../config/bot');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

client.commands = new Collection();
client.config = config;

// Load commands (commands/<folder>/<file>.js)
const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
    for (const folder of fs.readdirSync(commandsPath)) {
        const folderPath = path.join(commandsPath, folder);
        if (!fs.statSync(folderPath).isDirectory()) continue;
        for (const file of fs.readdirSync(folderPath).filter(f => f.endsWith('.js'))) {
            const command = require(path.join(folderPath, file));
            if ('data' in command && 'execute' in command) {
                client.commands.set(command.data.name, command);
            }
        }
    }
}

// Load events (events/<file>.js)
const eventsPath = path.join(__dirname, 'events');
if (fs.existsSync(eventsPath)) {
    for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'))) {
        const event = require(path.join(eventsPath, file));
        if (event.once) {
            client.once(event.name, (...args) => event.execute(...args, client));
        } else {
            client.on(event.name, (...args) => event.execute(...args, client));
        }
    }
}

client.once('ready', () => {
    console.log(`[SLTĐ's Bot] logged in as ${client.user.tag}`);
    console.log(`[SLTĐ's Bot] serving ${client.guilds.cache.size} guild(s).`);
});

client.login(process.env.BOT_TOKEN);

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
