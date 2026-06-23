require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const commands = [];
const foldersPath = path.join(__dirname, 'commands');
if (fs.existsSync(foldersPath)) {
    for (const folder of fs.readdirSync(foldersPath)) {
        const commandsPath = path.join(foldersPath, folder);
        if (!fs.statSync(commandsPath).isDirectory()) continue;
        for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
            const command = require(path.join(commandsPath, file));
            if ('data' in command && 'execute' in command) {
                commands.push(command.data.toJSON());
            }
        }
    }
}

const rest = new REST().setToken(process.env.BOT_TOKEN);

(async () => {
    try {
        console.log(`Refreshing ${commands.length} application (/) commands.`);

        const guildIds = (process.env.GUILD_IDS || '')
            .split(',').map(id => id.trim()).filter(Boolean);

        if (guildIds.length > 0) {
            for (const guildId of guildIds) {
                try {
                    const data = await rest.put(
                        Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
                        { body: commands }
                    );
                    console.log(`Reloaded ${data.length} commands for guild ${guildId}`);
                } catch (err) {
                    if (err.code === 50001) {
                        console.log(`[SKIPPED] Missing Access for guild ${guildId}.`);
                    } else {
                        console.error(`Error deploying to guild ${guildId}:`, err);
                    }
                }
            }
        } else {
            const data = await rest.put(
                Routes.applicationCommands(process.env.CLIENT_ID),
                { body: commands }
            );
            console.log(`Reloaded ${data.length} global (/) commands.`);
        }
    } catch (error) {
        console.error(error);
    }
})();
