const { Events, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const {
    ROLE, ROLE_LABEL, ROLE_DESC, ROLE_GUIDE, ROLE_TEAM, TEAM,
    getRoleDistribution,
} = require('../services/werewolfService');

const SCORE_DIR = path.join(__dirname, '../data');

// Shared registry populated by werewolf.js. Resolved at runtime.
function getActiveGame(channelId) {
    const m = global.__sltdActiveGames;
    if (!m) return null;
    return m.get(channelId) || null;
}

function loadScores(guildId) {
    try {
        const data = fs.readFileSync(path.join(SCORE_DIR, `masoi_scores_${guildId}.json`), 'utf8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message, client) {
        if (message.author.bot || !message.guild) return;

        // === !top — Ma Sói leaderboard ===
        if (message.content === '!top') {
            const scores = loadScores(message.guild.id);
            const sorted = Object.entries(scores)
                .sort((a, b) => b[1].score - a[1].score)
                .slice(0, 15);

            if (sorted.length === 0) {
                return message.reply('Chưa có ai chơi Ma Sói trong server này.');
            }

            const list = sorted.map(([id, data], i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                const sign = data.score >= 0 ? '+' : '';
                return `${medal} **${data.name}** — ${sign}${data.score} điểm (${data.wins}W/${data.losses}L)`;
            }).join('\n');

            const embed = new EmbedBuilder()
                .setColor(client.config.colors.accent)
                .setTitle("🏆 SLTĐ's Ma Sói — Bảng Xếp Hạng")
                .setDescription(list)
                .setFooter({ text: `Tổng ${Object.keys(scores).length} người chơi` })
                .setTimestamp();

            return message.reply({ embeds: [embed] });
        }

        // === !score [@user] — check individual score ===
        if (message.content === '!score' || message.content.startsWith('!score ')) {
            const targetUser = message.mentions.users.first() || message.author;
            const scores = loadScores(message.guild.id);
            const data = scores[targetUser.id];

            if (!data) {
                const name = targetUser.id === message.author.id ? 'Bạn' : `**${targetUser.displayName}**`;
                return message.reply(`${name} chưa chơi Ma Sói trong server này.`);
            }

            const sorted = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
            const rank = sorted.findIndex(([id]) => id === targetUser.id) + 1;

            const sign = data.score >= 0 ? '+' : '';
            const embed = new EmbedBuilder()
                .setColor(client.config.colors.accent)
                .setTitle(`Ma Sói — Điểm của ${data.name}`)
                .setDescription(
                    `Điểm: **${sign}${data.score}**\n` +
                    `Thắng: **${data.wins}** | Thua: **${data.losses}**\n` +
                    `Tổng ván: **${data.games}**\n` +
                    `Xếp hạng: **#${rank}** / ${sorted.length}`
                )
                .setFooter({ text: "SLTĐ's Bot" });

            return message.reply({ embeds: [embed] });
        }

        // === !role — show roles in the active game (or note if no game) ===
        if (message.content === '!role') {
            const game = getActiveGame(message.channel.id);
            const playerCount = game ? game.players.size : 0;

            if (!game) {
                const embed = new EmbedBuilder()
                    .setColor(client.config.colors.muted)
                    .setTitle("🐺 Vai trò trong ván hiện tại")
                    .setDescription(
                        'Hiện không có ván Ma Sói nào đang chạy ở kênh này.\n' +
                        'Dùng `/masoi play` để tạo lobby, hoặc gõ `!roles` để xem danh sách vai tổng thể.'
                    )
                    .setFooter({ text: "SLTĐ's Bot" });
                return message.reply({ embeds: [embed] });
            }

            // Tally roles from already-assigned players; if not yet assigned, use
            // distribution for the current player count.
            let roleCounts;
            const anyAssigned = [...game.players.values()].some(p => p.role);
            if (anyAssigned) {
                roleCounts = {};
                for (const p of game.players.values()) {
                    if (!p.role) continue;
                    roleCounts[p.role] = (roleCounts[p.role] || 0) + 1;
                }
            } else {
                roleCounts = getRoleDistribution(playerCount);
            }

            // Order roles for display
            const order = [
                ROLE.WEREWOLF, ROLE.WOLF_SEER, ROLE.HALF_WOLF,
                ROLE.SEER, ROLE.APPRENTICE_SEER, ROLE.WITCH, ROLE.GUARD,
                ROLE.HUNTER, ROLE.CUPID, ROLE.JAILER, ROLE.FOOL,
            ];
            const lines = order
                .filter(r => roleCounts[r])
                .map(r => `**${ROLE_LABEL[r]}** ×${roleCounts[r]}`);
            const villagers = playerCount - Object.values(roleCounts).reduce((a, b) => a + b, 0);
            if (villagers > 0) lines.push(`**${ROLE_LABEL[ROLE.VILLAGER]}** ×${villagers}`);

            const stateLabel = game.state === 'lobby' ? 'Lobby' : `Đang chơi (đêm ${game.round})`;
            const embed = new EmbedBuilder()
                .setColor(client.config.colors.accent)
                .setTitle(`🐺 Vai trong ván — ${stateLabel}`)
                .setDescription(
                    `**Tổng:** ${playerCount} người chơi\n\n` +
                    `**Các vai trong ván này:**\n${lines.join('\n')}\n\n` +
                    '_(Không tiết lộ ai giữ vai nào — chỉ liệt kê số lượng.)_'
                )
                .setFooter({ text: 'Gõ !roles để xem hướng dẫn đầy đủ + bảng phân bố' });

            return message.reply({ embeds: [embed] });
        }

        // === !roles — full role guide (grouped by faction) + distribution table ===
        if (message.content === '!roles') {
            const guideOrder = ['village', 'third', 'neutral', 'wolf'];
            const embeds = [];

            for (const key of guideOrder) {
                const g = ROLE_GUIDE[key];
                if (!g) continue;
                const roleText = g.roles
                    .map(r => `**${ROLE_LABEL[r]}:** ${ROLE_DESC[r]}`)
                    .join('\n\n');
                const embed = new EmbedBuilder()
                    .setColor(client.config.colors.accent)
                    .setTitle(g.title)
                    .setDescription(`_${g.intro}_\n\n${roleText}`);
                if (key === 'wolf') embed.setFooter({ text: "SLTĐ's Bot" });
                embeds.push(embed);
            }

            const brackets = [5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 17, 18, 20, 21, 25];
            const distLines = brackets.map(n => {
                const dist = getRoleDistribution(n);
                const roles = Object.entries(dist)
                    .map(([role, count]) => `${ROLE_LABEL[role]}${count > 1 ? ' ×' + count : ''}`)
                    .join(', ');
                const villagers = n - Object.values(dist).reduce((a, b) => a + b, 0);
                const vilNote = villagers > 0 ? `, Dân ×${villagers}` : '';
                return `**${n} người:** ${roles}${vilNote}`;
            }).join('\n');

            embeds.push(
                new EmbedBuilder()
                    .setColor(client.config.colors.accent)
                    .setTitle('📋 Phân bố vai trò theo số người')
                    .setDescription(distLines)
                    .setFooter({ text: 'Số dân = tổng người - tổng role đặc biệt' })
            );

            return message.reply({ embeds });
        }
    },
};
