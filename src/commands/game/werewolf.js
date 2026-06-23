const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    PermissionFlagsBits,
    MessageFlags,
    ComponentType,
    ChannelType,
} = require('discord.js');
const {
    WerewolfGame, ROLE, ROLE_LABEL, ROLE_DESC, ROLE_TEAM, TEAM, STATE,
    WINNER, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_DAY_MINUTES,
    isWolfTeam, isCrossFactionCouple, getDisplayRole,
} = require('../../services/werewolfService');

const activeGames = new Map();
const guildSettings = new Map();

// Timeout mặc định mỗi action trong đêm + vote treo cổ: 60s cho mọi vai và
// vote treo cổ, 90s cho Sói vote cắn, 180s (3 phút) cho Cupid đêm 1. Admin có
// thể đổi qua /masoi setup — các giá trị này chỉ là fallback khi guild chưa
// setup hoặc settings thiếu field.
const DEFAULT_ACTION_SECONDS = 60;
const DEFAULT_WOLF_VOTE_SECONDS = 90;
const DEFAULT_CUPID_SECONDS = 180;

// Default settings cho guild SLTĐ (persist qua restart)
guildSettings.set('1517042905846513746', {
    gameChannelId: '1517548683346837594',   // anh-em-chắc-bền-lâu
    deadChannelId: '1517045228211671101',   // giàn-thiêu
    wolfChannelId: '1517694938777653378',   // sói
    dayMinutes: 5,
    actionSeconds: DEFAULT_ACTION_SECONDS,
    wolfVoteSeconds: DEFAULT_WOLF_VOTE_SECONDS,
    cupidSeconds: DEFAULT_CUPID_SECONDS,
    nightProgressDm: true,
});

// Expose activeGames via a global map (shared with messageCreate.js for !role
// in-game lookup). Keyed by channelId. Populated on /masoi play, deleted on
// game over or stop.
if (!global.__sltdActiveGames) global.__sltdActiveGames = activeGames;

const SAYONARA_ROLE_NAME = 'sayonara';

// ── Score system (persistent JSON) ──────────────────────────
const _fs = require('fs');
const _path = require('path');
const SCORE_DIR = _path.join(__dirname, '../../data');

// ── Night log helper (ghi lại hoạt động đêm để recap endGame) ──
function appendLog(game, icon, text) {
    if (!game.nightLog || game.nightLog.length === 0) return;
    const current = game.nightLog[game.nightLog.length - 1];
    current.entries.push({ icon, text });
}

function getScorePath(guildId) {
    return _path.join(SCORE_DIR, `masoi_scores_${guildId}.json`);
}

function loadScores(guildId) {
    try {
        const data = _fs.readFileSync(getScorePath(guildId), 'utf8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

function saveScores(guildId, scores) {
    if (!_fs.existsSync(SCORE_DIR)) _fs.mkdirSync(SCORE_DIR, { recursive: true });
    _fs.writeFileSync(getScorePath(guildId), JSON.stringify(scores, null, 2), 'utf8');
}

function updateScores(guildId, winners, losers, playerMap) {
    const scores = loadScores(guildId);
    for (const id of winners) {
        if (!scores[id]) scores[id] = { name: '', score: 0, wins: 0, losses: 0, games: 0 };
        scores[id].name = playerMap.get(id)?.displayName || scores[id].name;
        scores[id].score += 1;
        scores[id].wins += 1;
        scores[id].games += 1;
    }
    for (const id of losers) {
        if (!scores[id]) scores[id] = { name: '', score: 0, wins: 0, losses: 0, games: 0 };
        scores[id].name = playerMap.get(id)?.displayName || scores[id].name;
        scores[id].score -= 1;
        scores[id].losses += 1;
        scores[id].games += 1;
    }
    saveScores(guildId, scores);
    return scores;
}

function getSettings(guildId) {
    if (!guildSettings.has(guildId)) {
        guildSettings.set(guildId, {
            gameChannelId: null,
            deadChannelId: null,
            wolfChannelId: null,
            dayMinutes: DEFAULT_DAY_MINUTES,
            actionSeconds: DEFAULT_ACTION_SECONDS,
            wolfVoteSeconds: DEFAULT_WOLF_VOTE_SECONDS,
            cupidSeconds: DEFAULT_CUPID_SECONDS,
            nightProgressDm: true,
        });
    }
    const settings = guildSettings.get(guildId);
    // Backfill for guilds saved before these fields existed.
    if (!settings.actionSeconds) settings.actionSeconds = DEFAULT_ACTION_SECONDS;
    if (!settings.wolfVoteSeconds) settings.wolfVoteSeconds = DEFAULT_WOLF_VOTE_SECONDS;
    if (!settings.cupidSeconds) settings.cupidSeconds = DEFAULT_CUPID_SECONDS;
    if (settings.nightProgressDm === undefined) settings.nightProgressDm = true;
    return settings;
}

function ms(minutes) { return minutes * 60_000; }

function playerList(players, showRole = false) {
    return players.map((p, i) => {
        let line = `${i + 1}. ${p.displayName}`;
        if (showRole) line += ` — ${getDisplayRole(p)}`;
        if (!p.alive) line += ' 💀';
        return line;
    }).join('\n');
}

function buildPlayerSelect(customId, players, placeholder) {
    if (players.length <= 25) {
        const menu = new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(placeholder)
            .addOptions(players.map(p => ({
                label: p.displayName,
                value: p.discordId,
            })));
        return new ActionRowBuilder().addComponents(menu);
    }
    const rows = [];
    for (let i = 0; i < players.length && rows.length < 5; i += 5) {
        const row = new ActionRowBuilder();
        const slice = players.slice(i, i + 5);
        for (const p of slice) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`${customId}_${p.discordId}`)
                    .setLabel(p.displayName)
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        rows.push(row);
    }
    return rows;
}

async function safeDM(client, userId, payload) {
    try {
        const user = await client.users.fetch(userId);
        return await user.send(payload);
    } catch {
        return null;
    }
}

async function collectDMSelect(dmMessage, timeoutMs) {
    try {
        const i = await dmMessage.awaitMessageComponent({ time: timeoutMs });
        await i.deferUpdate();
        if (i.isStringSelectMenu()) return i.values[0];
        if (i.isButton()) return i.customId;
        return null;
    } catch {
        return null;
    }
}

async function notifyNightProgress(game, client, text) {
    if (!game.nightProgressDm) return;
    const alive = game.getAlivePlayers();
    await Promise.all(alive.map(p => safeDM(client, p.discordId, { content: `✅ ${text}` })));
}

// ── Sayonara role ───────────────────────────────────────────

async function findOrCreateSayonaraRole(guild) {
    let role = guild.roles.cache.find(r => r.name === SAYONARA_ROLE_NAME);
    if (!role) {
        role = await guild.roles.create({
            name: SAYONARA_ROLE_NAME,
            color: 0x71717a,
            reason: "SLTĐ's Bot — Ma Sói: role cho người chết",
        });
    }
    return role;
}

async function assignSayonara(guild, userId) {
    try {
        const role = await findOrCreateSayonaraRole(guild);
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && !member.roles.cache.has(role.id)) {
            await member.roles.add(role, 'Ma Sói — đã chết');
        }
    } catch (e) {
        console.error(`[masoi] assignSayonara fail ${userId}:`, e.message);
    }
}

async function removeSayonaraAll(guild, playerIds) {
    try {
        const role = guild.roles.cache.find(r => r.name === SAYONARA_ROLE_NAME);
        if (!role) return;
        for (const id of playerIds) {
            const member = await guild.members.fetch(id).catch(() => null);
            if (member?.roles.cache.has(role.id)) {
                await member.roles.remove(role, 'Ma Sói — game kết thúc');
            }
        }
    } catch (e) {
        console.error('[masoi] removeSayonaraAll fail:', e.message);
    }
}

// ── Game channel lock (chỉ player mới chat được) ───────────

async function lockGameChannel(game, channel) {
    const guild = channel.guild;
    // 1. Khoá @everyone khỏi chat
    try {
        await channel.permissionOverwrites.edit(guild.id, {
            SendMessages: false,
            AddReactions: false,
        }, { reason: 'Ma Sói — khoá chat kênh game, chỉ người chơi được chat' });
    } catch (e) {
        console.error('[masoi] lockGameChannel @everyone fail:', e.message);
    }
    // 2. Cấp quyền chat cho từng player
    for (const p of game.players.values()) {
        try {
            await channel.permissionOverwrites.edit(p.discordId, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
                AddReactions: true,
            }, { reason: 'Ma Sói — cấp quyền chat cho người chơi' });
        } catch (e) {
            console.error(`[masoi] lockGameChannel player ${p.displayName} fail:`, e.message);
        }
    }
}

async function restoreGameChannel(channel) {
    const guild = channel.guild;
    try {
        const ow = channel.permissionOverwrites.cache.get(guild.id);
        if (ow) {
            await channel.permissionOverwrites.edit(guild.id, {
                SendMessages: null,
                AddReactions: null,
            }, { reason: 'Ma Sói — game kết thúc, trả lại kênh' });
        }
    } catch (e) {
        console.error('[masoi] restoreGameChannel @everyone fail:', e.message);
    }
}


async function setupDeadChannelPermissions(guild) {
    const settings = getSettings(guild.id);
    if (!settings.deadChannelId) return;
    const deadChannel = await guild.channels.fetch(settings.deadChannelId).catch(() => null);
    if (!deadChannel) return;
    try {
        const role = await findOrCreateSayonaraRole(guild);  // FIX #4: was findOrCreateVongRole (undefined)
        // Khoá @everyone
        await deadChannel.permissionOverwrites.edit(guild.id, {
            SendMessages: false,
        }, { reason: 'Ma Sói — kênh mồ mả: chỉ Vong chat' });
        // Cho role Vong chat
        await deadChannel.permissionOverwrites.edit(role.id, {
            ViewChannel: true,
            SendMessages: true,
            AddReactions: true,
            ReadMessageHistory: true,
        }, { reason: 'Ma Sói — cấp quyền chat cho Vong' });
    } catch (e) {
        console.error('[masoi] setupDeadChannelPermissions fail:', e.message);
    }
}
// ── Night/Day lock ──────────────────────────────────────────

async function lockNight(game, channel) {
    const alive = game.getAlivePlayers();
    const guild = channel.guild;

    for (const p of alive) {
        try {
            await channel.permissionOverwrites.edit(p.discordId, {
                SendMessages: false,
                AddReactions: false,
            });
        } catch (e) {
            console.error(`[masoi] lockNight chat fail ${p.displayName}:`, e.message);
        }
    }

    for (const p of alive) {
        try {
            const member = await guild.members.fetch(p.discordId).catch(() => null);
            if (member?.voice?.channel) {
                await member.voice.setMute(true, 'Ma Sói — ban đêm');
            }
        } catch (e) {
            console.error(`[masoi] lockNight voice fail ${p.displayName}:`, e.message);
        }
    }
}

async function unlockDay(game, channel) {
    const alive = game.getAlivePlayers();
    const guild = channel.guild;

    for (const p of alive) {
        try {
            const overwrite = channel.permissionOverwrites.cache.get(p.discordId);
            if (overwrite) {
                await channel.permissionOverwrites.edit(p.discordId, {
                    SendMessages: true,
                    AddReactions: true,
                });
            }
        } catch (e) {
            console.error(`[masoi] unlockDay chat fail ${p.displayName}:`, e.message);
        }
    }

    for (const p of alive) {
        try {
            const member = await guild.members.fetch(p.discordId).catch(() => null);
            if (member?.voice?.channel && member.voice.serverMute) {
                await member.voice.setMute(false, 'Ma Sói — ban ngày');
            }
        } catch (e) {
            console.error(`[masoi] unlockDay voice fail ${p.displayName}:`, e.message);
        }
    }
}

async function cleanupPermissions(game, channel) {
    const allPlayers = [...game.players.values()];
    const guild = channel.guild;

    for (const p of allPlayers) {
        try {
            const overwrite = channel.permissionOverwrites.cache.get(p.discordId);
            if (overwrite) {
                await overwrite.delete('Ma Sói — game kết thúc');
            }
        } catch {}
        try {
            const member = await guild.members.fetch(p.discordId).catch(() => null);
            if (member?.voice?.channel && member.voice.serverMute) {
                await member.voice.setMute(false, 'Ma Sói — game kết thúc');
            }
        } catch {}
    }

    await removeSayonaraAll(guild, allPlayers.map(p => p.discordId));
    // Trả lại quyền chat @everyone cho kênh game
    await restoreGameChannel(channel);
}

// ── Wolf channel access ────────────────────────────────────

const WOLF_CHANNEL_PERMS = {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AddReactions: true,
    EmbedLinks: true,
    AttachFiles: true,
};

async function setupWolfChannelAccess(game, client, guild) {
    // Find the configured wolf channel (from /masoi setup wolf_channel).
    // Falls back to a default if not set.
    const settings = getSettings(guild.id);
    if (!settings.wolfChannelId) return;
    const wolfCh = await client.channels.fetch(settings.wolfChannelId).catch(() => null);
    if (!wolfCh) return;

    // First-time setup: hide from @everyone (one-time idempotent).
    try {
        const everyone = wolfCh.permissionOverwrites.cache.get(guild.id);
        if (!everyone || !everyone.deny.has('ViewChannel')) {
            await wolfCh.permissionOverwrites.edit(guild.id, { ViewChannel: false });
        }
    } catch (e) {
        console.error('[masoi] wolfCh @everyone hide fail:', e.message);
    }

    // Add all current wolves (WEREWOLF + WOLF_SEER) — bán sói added on transform.
    for (const w of game.getWolfChannelMembers()) {
        try {
            await wolfCh.permissionOverwrites.edit(w.discordId, WOLF_CHANNEL_PERMS);
            game.addWolfChannelAccess(w.discordId);
        } catch (e) {
            console.error(`[masoi] wolfCh add ${w.displayName} fail:`, e.message);
        }
    }
}

async function cleanupWolfChannelAccess(game, client, guild) {
    if (game.wolfChannelAccessIds.size === 0) return;
    const settings = getSettings(guild.id);
    if (!settings.wolfChannelId) return;
    const wolfCh = await client.channels.fetch(settings.wolfChannelId).catch(() => null);
    if (!wolfCh) return;

    for (const id of game.wolfChannelAccessIds) {
        try {
            const ow = wolfCh.permissionOverwrites.cache.get(id);
            if (ow) await ow.delete('Ma Sói — game kết thúc');
        } catch (e) {
            console.error(`[masoi] wolfCh remove ${id} fail:`, e.message);
        }
    }
    game.clearWolfChannelAccess();
}

// Standalone cleanup — used by /masoi stop when no game is active.
// SCOPE: chỉ chạm đúng 3 channel đã định trong settings (gameChannelId, wolfChannelId, deadChannelId).
// Channel khác trong guild BOT KHÔNG ĐỘNG VÀO — kể cả override của admin, bot khác, hay user lạ.
// Dùng khi: admin reset sau bot crash, override cũ còn sót trên 3 channel Ma Sói quản lý.
async function cleanupGuildFully(guild) {
    const settings = getSettings(guild.id);
    const stats = {
        gameChannel: null,    // { cleaned: 0, everyoneRestored: bool }
        wolfChannel: null,    // { dropped: 0, everyoneKept: bool }
        deadChannel: null,    // { dropped: 0, sayonaraKept: bool }
        sayonaraRemoved: 0,
    };

    // Collect sayonara role id (nếu có) — để biết override nào cần GIỮ trên dead channel
    const sayonara = guild.roles.cache.find(r => r.name === SAYONARA_ROLE_NAME);
    const sayonaraId = sayonara?.id;

    // Collect wolf player ids (nếu có game active) — để biết override nào cần GIỮ trên wolf channel
    // Lưu ý: function này chỉ chạy khi KHÔNG có game active (MODE B), nên set rỗng.
    const wolfPlayerIds = new Set();

    async function cleanGameChannel(channelId) {
        if (!channelId) return;
        const ch = await guild.channels.fetch(channelId).catch(() => null);
        if (!ch || !ch.isTextBased?.()) return;
        let cleaned = 0;
        // Drop tất cả override không phải @everyone
        for (const [id, ow] of ch.permissionOverwrites.cache) {
            if (id === guild.id) continue;
            try {
                await ow.delete('Ma Sói — standalone cleanup');
                cleaned++;
            } catch (e) {
                console.error(`[masoi] gameCh drop ${id}:`, e.message);
            }
        }
        // Restore @everyone: cho phép gửi/react lại
        const everyoneOw = ch.permissionOverwrites.cache.get(guild.id);
        let everyoneRestored = false;
        if (everyoneOw) {
            try {
                await ch.permissionOverwrites.edit(guild.id, {
                    SendMessages: null,
                    AddReactions: null,
                }, { reason: 'Ma Sói — standalone cleanup, trả lại kênh game' });
                everyoneRestored = true;
            } catch (e) {
                console.error('[masoi] gameCh restore @everyone:', e.message);
            }
        }
        stats.gameChannel = { cleaned, everyoneRestored };
    }

    async function cleanWolfChannel(channelId) {
        if (!channelId) return;
        const ch = await guild.channels.fetch(channelId).catch(() => null);
        if (!ch || !ch.isTextBased?.()) return;
        let dropped = 0;
        // Drop user override KHÔNG thuộc wolf player set (set rỗng ở MODE B)
        // → vì không có game active, không biết user nào là sói → drop tất cả user override
        // Override của role đặc biệt (nếu có) cũng drop — chỉ giữ @everyone
        for (const [id, ow] of ch.permissionOverwrites.cache) {
            if (id === guild.id) continue;  // giữ @everyone (ViewChannel:false)
            if (wolfPlayerIds.has(id)) continue;
            try {
                await ow.delete('Ma Sói — standalone cleanup, phòng sói');
                dropped++;
            } catch (e) {
                console.error(`[masoi] wolfCh drop ${id}:`, e.message);
            }
        }
        // KHÔNG động @everyone — ViewChannel:false cho @everyone là setup bắt buộc để phòng sói private
        stats.wolfChannel = { dropped, everyoneKept: true };
    }

    async function cleanDeadChannel(channelId) {
        if (!channelId) return;
        const ch = await guild.channels.fetch(channelId).catch(() => null);
        if (!ch || !ch.isTextBased?.()) return;
        let dropped = 0;
        // Drop user override (không phải role sayonara, không phải @everyone)
        for (const [id, ow] of ch.permissionOverwrites.cache) {
            if (id === guild.id) continue;       // giữ @everyone (SendMessages:false)
            if (id === sayonaraId) continue;     // giữ sayonara (ViewChannel:true)
            try {
                await ow.delete('Ma Sói — standalone cleanup, kênh mồ mả');
                dropped++;
            } catch (e) {
                console.error(`[masoi] deadCh drop ${id}:`, e.message);
            }
        }
        stats.deadChannel = { dropped, sayonaraKept: !!sayonaraId };
    }

    // Chạy tuần tự trên đúng 3 channel từ settings
    await cleanGameChannel(settings.gameChannelId);
    await cleanWolfChannel(settings.wolfChannelId);
    await cleanDeadChannel(settings.deadChannelId);

    // Remove sayonara role khỏi members đang giữ (cleanup trạng thái Vong)
    if (sayonara) {
        for (const [, member] of guild.members.cache) {
            if (member.roles.cache.has(sayonara.id)) {
                try {
                    await member.roles.remove(sayonara, 'Ma Sói — standalone cleanup');
                    stats.sayonaraRemoved++;
                } catch (e) {
                    console.error(`[masoi] standalone remove sayonara ${member.displayName}:`, e.message);
                }
            }
        }
    }

    return stats;
}

async function addWolfChannelUser(game, client, guild, player) {
    const settings = getSettings(guild.id);
    if (!settings.wolfChannelId || !player) return;
    const wolfCh = await client.channels.fetch(settings.wolfChannelId).catch(() => null);
    if (!wolfCh) return;
    try {
        await wolfCh.permissionOverwrites.edit(player.discordId, WOLF_CHANNEL_PERMS);
        game.addWolfChannelAccess(player.discordId);
    } catch (e) {
        console.error(`[masoi] wolfCh add ${player.displayName} fail:`, e.message);
    }
}

async function removeWolfChannelUsers(game, client, guild, userIds, reason = 'Ma Sói — sói đã chết') {
    const settings = getSettings(guild.id);
    if (!settings.wolfChannelId || !userIds.length) return;
    const wolfCh = await client.channels.fetch(settings.wolfChannelId).catch(() => null);
    if (!wolfCh) return;
    for (const id of userIds) {
        if (!game.wolfChannelAccessIds.has(id)) continue;
        try {
            const ow = wolfCh.permissionOverwrites.cache.get(id);
            if (ow) await ow.delete(reason);
            game.wolfChannelAccessIds.delete(id);
        } catch (e) {
            console.error(`[masoi] wolfCh remove ${id} fail:`, e.message);
        }
    }
}

async function muteDead(game, channel, deadIds) {
    const guild = channel.guild;
    for (const id of deadIds) {
        const p = game.players.get(id);
        if (!p) continue;
        try {
            await channel.permissionOverwrites.edit(id, { SendMessages: false, AddReactions: false });
        } catch {}
        try {
            const member = await guild.members.fetch(id).catch(() => null);
            if (member?.voice?.channel && !member.voice.serverMute) {
                await member.voice.setMute(true, 'Ma Sói — đã chết');
            }
        } catch {}
        await assignSayonara(guild, id);
    }
}

// ── Night Phase ─────────────────────────────────────────────

async function runNight(game, channel, client) {
    game.startNight();
    await lockNight(game, channel);

    const nightEmbed = new EmbedBuilder()
        .setColor(0x1a1a2e)
        .setTitle(`Đêm ${game.round}`)
        .setDescription(
            'Trời tối rồi... Mọi người đi ngủ.\n' +
            '🔇 Chat và mic đã bị tắt.\n' +
            'Các vai trò đặc biệt hãy kiểm tra DM để hành động!'
        )
        .setFooter({ text: 'Đêm sẽ kết thúc ngay khi tất cả chức năng hoàn thành.' });

    await channel.send({ embeds: [nightEmbed] });

    // Night 1: Cupid picks couple
    if (game.round === 1) {
        await runCupidPair(game, client, game.cupidTimeoutMs);
        await notifyNightProgress(game, client, 'Cupid đã hoàn thành chức năng.');
    }

    // (1) Jailer picks target FIRST (protects from bite + blocks actions)
    await runJailerAction(game, client, game.actionTimeoutMs);
    await notifyNightProgress(game, client, 'Quản ngục đã hoàn thành chức năng.');

    // (2) Role info/protection, lần lượt theo turn
    await runSeerCheck(game, client, game.actionTimeoutMs);
    await notifyNightProgress(game, client, 'Tiên tri đã hoàn thành chức năng.');

    await runGuardProtect(game, client, game.actionTimeoutMs);
    await notifyNightProgress(game, client, 'Bảo vệ đã hoàn thành chức năng.');

    await runWolfSeerDivine(game, client, game.actionTimeoutMs);
    await notifyNightProgress(game, client, 'Sói tiên tri đã hoàn thành chức năng.');

    if (game.isMainSeerDead()) {
        await runApprenticeSeerCheck(game, client, game.actionTimeoutMs);
        await notifyNightProgress(game, client, 'Tiên tri tập sự đã hoàn thành chức năng.');
    }

    // (3) Wolf bite vote (kế cuối)
    await runWolfVote(game, client, game.wolfVoteTimeoutMs);
    await notifyNightProgress(game, client, 'Sói đã hoàn thành chức năng.');

    // (4) Witch acts last (sees the wolf target for heal decision)
    await runWitchAction(game, client, game.actionTimeoutMs);
    await notifyNightProgress(game, client, 'Phù thủy đã hoàn thành chức năng.');

    const result = game.resolveNight();
    return result;
}

// ── Cupid ───────────────────────────────────────────────────

async function runCupidPair(game, client, timeoutMs) {
    const cupid = game.getPlayerByRole(ROLE.CUPID);
    if (!cupid) return;

    const others = game.getAlivePlayersExcept(cupid.discordId);
    if (others.length < 2) return;

    const embed = new EmbedBuilder()
        .setColor(0xff69b4)
        .setTitle('Đêm 1 — Cupid ghép đôi')
        .setDescription('Chọn **2 người** để ghép đôi. Nếu 1 trong 2 chết, người kia cũng chết theo!\nBạn không biết thân phận của 2 người được ghép.');

    const menu = new StringSelectMenuBuilder()
        .setCustomId('cupid_pair')
        .setPlaceholder('Chọn 2 người...')
        .setMinValues(2)
        .setMaxValues(2)
        .addOptions(others.map(p => ({
            label: p.displayName,
            value: p.discordId,
        })));

    const row = new ActionRowBuilder().addComponents(menu);
    const dmMsg = await safeDM(client, cupid.discordId, { embeds: [embed], components: [row] });

    let pair = null;

    if (dmMsg) {
        try {
            const i = await dmMsg.awaitMessageComponent({ time: timeoutMs });
            await i.deferUpdate();
            if (i.isStringSelectMenu() && i.values.length === 2) {
                pair = [i.values[0], i.values[1]];
                await dmMsg.edit({
                    content: `💕 Đã ghép đôi: **${game.players.get(pair[0])?.displayName}** & **${game.players.get(pair[1])?.displayName}**`,
                    embeds: [], components: [],
                });
            }
        } catch {
            await dmMsg.edit({ content: 'Hết thời gian — bot sẽ ghép đôi ngẫu nhiên.', embeds: [], components: [] }).catch(() => {});
        }
    }

    // Per spec, the pairing is mandatory — if Cupid didn't choose in time (or
    // had no DM), the bot pairs two random players.
    if (!pair) {
        const shuffled = [...others].sort(() => Math.random() - 0.5);
        pair = [shuffled[0].discordId, shuffled[1].discordId];
        appendLog(game, '💕', `Cupid không ghép đôi kịp — bot ghép ngẫu nhiên`);
    }

    game.submitCupidChoice(pair[0], pair[1]);
    const n1 = game.players.get(pair[0])?.displayName || '???';
    const n2 = game.players.get(pair[1])?.displayName || '???';
    appendLog(game, '💕', `Cupid ghép đôi: **${n1}** & **${n2}**`);

    // Notify each couple member: name + role of partner
    for (const id of pair) {
        const partnerId = id === pair[0] ? pair[1] : pair[0];
        const partner = game.players.get(partnerId);
        await safeDM(client, id, {
            embeds: [new EmbedBuilder()
                .setColor(0xff69b4)
                .setTitle('💕 Sống chết cùng nhau')
                .setDescription(
                    `Bạn đã thành đôi với **${partner?.displayName || '???'}** đang nắm giữ vai trò **${getDisplayRole(partner)}**.\n` +
                    `Hai bạn sẽ đồng hành cùng nhau, khi người này chết người kia cũng không thể sống tiếp.\n` +
                    `Chúc may mắn.`
                )]
        });
    }
}

// ── Jailer ──────────────────────────────────────────────────

async function runJailerAction(game, client, timeoutMs) {
    const jailer = game.getPlayerByRole(ROLE.JAILER);
    if (!jailer) return;
    if (game.isJailed(jailer.discordId)) return;

    const targets = game.getAlivePlayersExcept(jailer.discordId);
    if (targets.length === 0) return;

    const embed = new EmbedBuilder()
        .setColor(0x607d8b)
        .setTitle(`Đêm ${game.round} — Quản ngục`)
        .setDescription(
            'Chọn 1 người để giam đêm nay.\n' +
            'Người bị giam **không thể dùng chức năng** trong đêm, nhưng **được bảo vệ hoàn toàn khỏi sói cắn**.\n' +
            'Có thể giam cùng 1 người nhiều đêm liên tiếp.'
        );

    const selectRow = buildPlayerSelect('jailer_pick', targets, 'Chọn người để giam...');
    const rows = Array.isArray(selectRow) ? selectRow : [selectRow];
    const dmMsg = await safeDM(client, jailer.discordId, { embeds: [embed], components: rows });
    if (!dmMsg) return;

    const choice = await collectDMSelect(dmMsg, timeoutMs);
    const targetId = choice?.startsWith('jailer_pick_') ? choice.replace('jailer_pick_', '') : choice;

    if (targetId && game.players.has(targetId)) {
        game.submitJailerChoice(targetId);
        const tName = game.players.get(targetId).displayName;
        await dmMsg.edit({
            content: `🔒 Đã giam: **${tName}**`,
            embeds: [], components: [],
        });
        await safeDM(client, targetId, { content: 'Bạn đã bị Quản ngục giam giữ. Đêm nay không thể dùng được chức năng.' });
        appendLog(game, '🔒', `Quản ngục giam **${tName}**`);
    } else {
        await dmMsg.edit({ content: 'Hết thời gian — không giam ai.', embeds: [], components: [] }).catch(() => {});
        appendLog(game, '🔒', `Quản ngục không giam ai (timeout)`);
    }
}

// ── Wolf Vote ───────────────────────────────────────────────

async function runWolfVote(game, client, timeoutMs) {
    const wolves = [...game.players.values()].filter(p => p.alive && isWolfTeam(p));
    if (wolves.length === 0) return;

    // Filter out jailed wolves
    const activeWolves = wolves.filter(w => !game.isJailed(w.discordId));
    if (activeWolves.length === 0) {
        // All wolves jailed — notify them
        for (const wolf of wolves) {
            await safeDM(client, wolf.discordId, { content: '🔒 Bạn bị giam đêm nay — không thể cắn ai.' });
        }
        appendLog(game, '🐺', `Tất cả sói bị giam — không cắn ai`);
        return;
    }

    const allTargets = game.getWolfTargets();
    if (allTargets.length === 0) return;

    const pickCount = activeWolves.length === 1
        ? 1
        : Math.min(2, Math.max(1, allTargets.length - 1));

    // Notify jailed wolves
    for (const wolf of wolves) {
        if (game.isJailed(wolf.discordId)) {
            await safeDM(client, wolf.discordId, { content: '🔒 Bạn bị giam đêm nay — không thể vote cắn.' });
        }
    }

    const dmPromises = activeWolves.map(async (wolf) => {
        const embed = new EmbedBuilder()
            .setColor(0x8b0000)
            .setTitle(`Đêm ${game.round} — Sói cắn`)
            .setDescription(
                activeWolves.length === 1
                    ? 'Chọn **1 người** để cắn đêm nay:'
                    : `Chọn **${pickCount} người** để đề cử cắn đêm nay.\nNếu có người trùng nhau giữa các sói → chọn người đó!`
            );

        const menu = new StringSelectMenuBuilder()
            .setCustomId('wolf_vote')
            .setPlaceholder(`Chọn ${pickCount} mục tiêu...`)
            .setMinValues(pickCount)
            .setMaxValues(pickCount)
            .addOptions(allTargets.map(p => ({
                label: p.displayName,
                value: p.discordId,
            })));

        const row = new ActionRowBuilder().addComponents(menu);
        const dmMsg = await safeDM(client, wolf.discordId, { embeds: [embed], components: [row] });
        if (!dmMsg) return;

        try {
            const i = await dmMsg.awaitMessageComponent({ time: timeoutMs });
            await i.deferUpdate();
            if (i.isStringSelectMenu() && i.values.length > 0) {
                game.submitWolfVoteBatch(wolf.discordId, i.values.filter(id => game.players.get(id)?.alive));
                const names = i.values.map(id => game.players.get(id)?.displayName || '???').join(', ');
                await dmMsg.edit({ content: `Đã chọn: **${names}**`, embeds: [], components: [] });
            }
        } catch {
            await dmMsg.edit({ content: 'Hết thời gian — chưa chọn.', embeds: [], components: [] }).catch(() => {});
        }
    });

    await Promise.all(dmPromises);

    // Resolve loop
    let maxRetries = 5;
    while (maxRetries-- > 0) {
        const result = game.resolveWolfVotes();

        if (result.resolved) {
            if (!result.target) {
                for (const wolf of activeWolves) {
                    await safeDM(client, wolf.discordId, { content: 'Hết thời gian — đêm nay không cắn ai.' });
                }
                appendLog(game, '🐺', `Sói không cắn ai (timeout)`);
                return;
            }
            const targetName = game.players.get(result.target)?.displayName || '???';
            for (const wolf of activeWolves) {
                await safeDM(client, wolf.discordId, { content: `Đã quyết định cắn: **${targetName}** 🐺` });
            }
            appendLog(game, '🐺', `Sói vote cắn: **${targetName}**`);
            return;
        }

        game.wolfVotes.clear();
        const tiedTargets = result.tied.map(id => game.players.get(id)).filter(p => p && p.alive);

        if (tiedTargets.length <= 1) {
            game.wolfTarget = tiedTargets[0]?.discordId || allTargets[0]?.discordId || null;
            const tName = game.players.get(game.wolfTarget)?.displayName || '???';
            appendLog(game, '🐺', `Sói vote cắn: **${tName}** (đồng thuận)`);
            return;
        }

        const retryPromises = activeWolves.map(async (wolf) => {
            const tiedNames = tiedTargets.map(p => p.displayName).join(', ');
            const embed = new EmbedBuilder()
                .setColor(0x8b0000)
                .setTitle('Nhiều mục tiêu trùng! Chọn lại')
                .setDescription(`Các mục tiêu trùng: **${tiedNames}**\nChọn **1 người** để cắn:`);

            const selectRow = buildPlayerSelect('wolf_retry', tiedTargets, 'Chọn 1 mục tiêu...');
            const rows = Array.isArray(selectRow) ? selectRow : [selectRow];
            const dmMsg = await safeDM(client, wolf.discordId, { embeds: [embed], components: rows });
            if (!dmMsg) return;

            const choice = await collectDMSelect(dmMsg, game.wolfVoteTimeoutMs);
            const targetId = choice?.startsWith('wolf_retry_') ? choice.replace('wolf_retry_', '') : choice;
            if (targetId && game.players.has(targetId)) {
                game.submitWolfVoteBatch(wolf.discordId, [targetId]);
                await dmMsg.edit({ content: `Đã chọn: **${game.players.get(targetId).displayName}**`, embeds: [], components: [] });
            } else {
                await dmMsg.edit({ content: 'Hết thời gian.', embeds: [], components: [] }).catch(() => {});
            }
        });

        await Promise.all(retryPromises);
    }

    if (!game.wolfTarget) {
        const targets = game.getWolfTargets();
        game.wolfTarget = targets[Math.floor(Math.random() * targets.length)]?.discordId || null;
        const rName = game.players.get(game.wolfTarget)?.displayName || '???';
        appendLog(game, '🐺', `Sói vote cắn (random sau 5 revote): **${rName}**`);
    }
}

// ── Seer ────────────────────────────────────────────────────

async function runSeerCheck(game, client, timeoutMs) {
    const seer = game.getPlayerByRole(ROLE.SEER);
    if (!seer) return;
    if (game.isJailed(seer.discordId)) {
        await safeDM(client, seer.discordId, { content: '🔒 Bạn bị giam đêm nay — không thể soi ai.' });
        return;
    }

    const targets = game.getAlivePlayersExcept(seer.discordId);
    const embed = new EmbedBuilder()
        .setColor(0x6a0dad)
        .setTitle(`Đêm ${game.round} — Tiên tri soi`)
        .setDescription('Chọn 1 người để soi:');

    const selectRow = buildPlayerSelect('seer_check', targets, 'Chọn mục tiêu...');
    const rows = Array.isArray(selectRow) ? selectRow : [selectRow];
    const dmMsg = await safeDM(client, seer.discordId, { embeds: [embed], components: rows });
    if (!dmMsg) return;

    const choice = await collectDMSelect(dmMsg, timeoutMs);
    let targetId = choice?.startsWith('seer_check_') ? choice.replace('seer_check_', '') : choice;
    let autoPicked = false;

    if (!targetId || !game.players.has(targetId)) {
        // Harmless role: auto-pick a random valid target on timeout, per spec.
        targetId = targets[Math.floor(Math.random() * targets.length)]?.discordId || null;
        autoPicked = true;
    }

    if (targetId) {
        const result = game.submitSeerCheck(targetId);
        const target = game.players.get(targetId);
        const prefix = autoPicked ? `Hết thời gian sử dụng chức năng. Tự động chọn **${target.displayName}** để thực hiện:\n` : '';
        await dmMsg.edit({
            content: `${prefix}🔮 **${target.displayName}** — thân phận: **${result}**`,
            embeds: [], components: [],
        });
        appendLog(game, '🔮', `Tiên tri soi **${target.displayName}** → ${result}${autoPicked ? ' (auto-pick timeout)' : ''}`);
    } else {
        await dmMsg.edit({ content: 'Hết thời gian — không soi được ai.', embeds: [], components: [] });
        appendLog(game, '🔮', `Tiên tri không soi (timeout)`);
    }
}

// ── Wolf Seer (soi + penalty) ───────────────────────────────

async function runWolfSeerDivine(game, client, timeoutMs) {
    const wolfSeer = game.getPlayerByRole(ROLE.WOLF_SEER);
    if (!wolfSeer) return;
    if (game.isJailed(wolfSeer.discordId)) {
        await safeDM(client, wolfSeer.discordId, { content: '🔒 Bạn bị giam đêm nay — không thể soi vai trò.' });
        return;
    }

    const targets = game.getAlivePlayersExcept(wolfSeer.discordId);
    const embed = new EmbedBuilder()
        .setColor(0x8b0000)
        .setTitle(`Đêm ${game.round} — Sói tiên tri soi`)
        .setDescription(
            'Bạn có thể soi 1 người để biết thân phận, hoặc bỏ qua.\n' +
            '⚠️ Nếu soi, ngày mai bạn sẽ không thể bỏ phiếu treo cổ — phiếu của bạn mặc định là bỏ qua.'
        );

    const skipButton = new ButtonBuilder()
        .setCustomId('wolfseer_skip')
        .setLabel('Bỏ qua')
        .setStyle(ButtonStyle.Secondary);

    const targetRow = buildPlayerSelect('wolfseer_pick', targets, 'Chọn mục tiêu...');
    const rows = Array.isArray(targetRow) ? targetRow : [targetRow];
    const buttonRow = new ActionRowBuilder().addComponents(skipButton);
    const dmMsg = await safeDM(client, wolfSeer.discordId, { embeds: [embed], components: [...rows, buttonRow] });
    if (!dmMsg) return;

    const choice = await collectDMSelect(dmMsg, timeoutMs);
    if (!choice) {
        await dmMsg.edit({ content: 'Hết thời gian — không soi.', embeds: [], components: [] }).catch(() => {});
        appendLog(game, '🐺🔮', `Sói tiên tri không soi (timeout)`);
        return;
    }
    if (choice === 'wolfseer_skip') {
        await dmMsg.edit({ content: 'Đã bỏ qua soi đêm nay.', embeds: [], components: [] });
        appendLog(game, '🐺🔮', `Sói tiên tri không soi (skip)`);
        return;
    }
    const targetId = choice.startsWith('wolfseer_pick_') ? choice.replace('wolfseer_pick_', '') : choice;
    if (targetId && game.players.has(targetId)) {
        const result = game.submitWolfSeerCheck(targetId);
        const target = game.players.get(targetId);
        await dmMsg.edit({
            content: `🐺🔮 **${target.displayName}** — thân phận: **${result}**\n⚠️ Ngày mai bạn sẽ không thể bỏ phiếu treo cổ (mặc định bỏ qua).`,
            embeds: [], components: [],
        });
        appendLog(game, '🐺🔮', `Sói tiên tri soi **${target.displayName}** → ${result} (không thể vote treo ngày mai)`);
    } else {
        await dmMsg.edit({ content: 'Không hợp lệ — không soi.', embeds: [], components: [] }).catch(() => {});
    }
}

// ── Apprentice Seer (chỉ khi Tiên tri chết) ─────────────────

async function runApprenticeSeerCheck(game, client, timeoutMs) {
    const apprentice = game.getPlayerByRole(ROLE.APPRENTICE_SEER);
    if (!apprentice) return;
    if (game.isJailed(apprentice.discordId)) {
        await safeDM(client, apprentice.discordId, { content: '🔒 Bạn bị giam đêm nay — không thể soi.' });
        return;
    }

    const targets = game.getAlivePlayersExcept(apprentice.discordId);
    const embed = new EmbedBuilder()
        .setColor(0x6a0dad)
        .setTitle(`Đêm ${game.round} — Tiên tri tập sự`)
        .setDescription('Tiên tri đã chết — bạn kế thừa khả năng soi.\nChỉ phân biệt được phe Dân; mọi thứ khác hiện "không soi được".');

    const selectRow = buildPlayerSelect('apprentice_check', targets, 'Chọn mục tiêu...');
    const rows = Array.isArray(selectRow) ? selectRow : [selectRow];
    const dmMsg = await safeDM(client, apprentice.discordId, { embeds: [embed], components: rows });
    if (!dmMsg) return;

    const choice = await collectDMSelect(dmMsg, timeoutMs);
    let targetId = choice?.startsWith('apprentice_check_') ? choice.replace('apprentice_check_', '') : choice;
    let autoPicked = false;

    if (!targetId || !game.players.has(targetId)) {
        targetId = targets[Math.floor(Math.random() * targets.length)]?.discordId || null;
        autoPicked = true;
    }

    if (targetId) {
        const result = game.submitApprenticeSeerCheck(targetId);
        const target = game.players.get(targetId);
        const readable = result === 'village' ? 'thuộc phe Dân' : 'không thể xác nhận được thuộc phe nào';
        const prefix = autoPicked ? `Hết thời gian sử dụng chức năng. Tự động chọn **${target.displayName}** để thực hiện:\n` : '';
        const msg = result === 'village'
            ? `${prefix}🟢 **${target.displayName}** thuộc phe Dân.`
            : `${prefix}⚪ Không thể xác nhận được **${target.displayName}** thuộc phe nào.`;
        await dmMsg.edit({ content: msg, embeds: [], components: [] });
        appendLog(game, '🔮', `Tiên tri tập sự soi **${target.displayName}** → ${readable}${autoPicked ? ' (auto-pick timeout)' : ''}`);
    } else {
        await dmMsg.edit({ content: 'Hết thời gian — không soi.', embeds: [], components: [] }).catch(() => {});
        appendLog(game, '🔮', `Tiên tri tập sự không soi (timeout)`);
    }
}

// ── Guard ───────────────────────────────────────────────────

async function runGuardProtect(game, client, timeoutMs) {
    const guard = game.getPlayerByRole(ROLE.GUARD);
    if (!guard) return;
    if (game.isJailed(guard.discordId)) {
        await safeDM(client, guard.discordId, { content: '🔒 Bạn bị giam đêm nay — không thể bảo vệ ai.' });
        return;
    }

    let targets = game.getAlivePlayers();
    if (game.guardPrevTarget) {
        targets = targets.filter(p => p.discordId !== game.guardPrevTarget);
    }

    const embed = new EmbedBuilder()
        .setColor(0x2196f3)
        .setTitle(`Đêm ${game.round} — Bảo vệ`)
        .setDescription(
            'Chọn 1 người để bảo vệ đêm nay:' +
            (game.guardPrevTarget ? `\n(Không được chọn lại người đêm trước)` : '')
        );

    const selectRow = buildPlayerSelect('guard_protect', targets, 'Chọn mục tiêu...');
    const rows = Array.isArray(selectRow) ? selectRow : [selectRow];
    const dmMsg = await safeDM(client, guard.discordId, { embeds: [embed], components: rows });
    if (!dmMsg) return;

    const choice = await collectDMSelect(dmMsg, timeoutMs);
    let targetId = choice?.startsWith('guard_protect_') ? choice.replace('guard_protect_', '') : choice;
    let autoPicked = false;

    if (!targetId || !game.players.has(targetId) || !game.canGuardProtect(targetId)) {
        // targets here is already filtered to exclude guardPrevTarget.
        targetId = targets[Math.floor(Math.random() * targets.length)]?.discordId || null;
        autoPicked = true;
    }

    if (targetId) {
        game.submitGuardProtect(targetId);
        const tName = game.players.get(targetId).displayName;
        const prefix = autoPicked ? `Hết thời gian sử dụng chức năng. Tự động chọn **${tName}** để thực hiện:\n` : '';
        await dmMsg.edit({
            content: `${prefix}Đã bảo vệ: **${tName}**`,
            embeds: [], components: [],
        });
        appendLog(game, '🛡️', `Bảo vệ chọn **${tName}**${autoPicked ? ' (auto-pick timeout)' : ''}`);
    } else {
        await dmMsg.edit({ content: 'Hết thời gian — không bảo vệ ai.', embeds: [], components: [] });
        appendLog(game, '🛡️', `Bảo vệ không chọn ai (timeout)`);
    }
}

// ── Witch ───────────────────────────────────────────────────

async function runWitchAction(game, client, timeoutMs) {
    const witch = game.getPlayerByRole(ROLE.WITCH);
    if (!witch) return;
    if (game.witchHealUsed && game.witchPoisonUsed) return;
    if (game.isJailed(witch.discordId)) {
        await safeDM(client, witch.discordId, { content: '🔒 Bạn bị giam đêm nay — không thể hành động.' });
        return;
    }

    const bitten = game.wolfTarget ? game.players.get(game.wolfTarget) : null;
    const bittenGuarded = game.guardTarget === game.wolfTarget;

    let desc = '';
    if (!game.witchHealUsed) {
        if (bitten && !bittenGuarded) {
            desc += `Người chơi **${bitten.displayName}** đã bị Sói cắn.\n\n`;
        } else {
            desc += 'Đêm nay không ai bị cắn (hoặc đã được bảo vệ).\n\n';
        }
    }

    const buttons = [];

    if (!game.witchHealUsed && bitten && !bittenGuarded) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId('witch_heal')
                .setLabel(`Cứu ${bitten.displayName}`)
                .setStyle(ButtonStyle.Success)
        );
    }

    if (!game.witchPoisonUsed) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId('witch_poison')
                .setLabel('Đầu độc')
                .setStyle(ButtonStyle.Danger)
        );
    }

    buttons.push(
        new ButtonBuilder()
            .setCustomId('witch_skip')
            .setLabel('Bỏ qua')
            .setStyle(ButtonStyle.Secondary)
    );

    desc += 'Chọn hành động:';
    if (!game.witchHealUsed && bitten && !bittenGuarded) desc += '\n🟢 **Cứu** — dùng bình cứu (1 lần/game)';
    if (!game.witchPoisonUsed) desc += '\n🔴 **Đầu độc** — chọn 1 người để giết (1 lần/game)';
    desc += '\n⬜ **Bỏ qua**';

    const embed = new EmbedBuilder()
        .setColor(0x9c27b0)
        .setTitle(`Đêm ${game.round} — Phù thủy`)
        .setDescription(desc);

    const row = new ActionRowBuilder().addComponents(buttons);
    const dmMsg = await safeDM(client, witch.discordId, { embeds: [embed], components: [row] });
    if (!dmMsg) return;

    const choice = await collectDMSelect(dmMsg, timeoutMs);

    if (choice === 'witch_heal') {
        game.submitWitchAction({ type: 'heal' });
        await dmMsg.edit({ content: `Đã dùng bình cứu — **${bitten.displayName}** được cứu sống!`, embeds: [], components: [] });
        appendLog(game, '💜', `Phù thủy cứu **${bitten.displayName}**`);
    } else if (choice === 'witch_poison') {
        const poisonTargets = game.getAlivePlayersExcept(witch.discordId);
        const poisonEmbed = new EmbedBuilder()
            .setColor(0x9c27b0)
            .setTitle('Chọn người để đầu độc')
            .setDescription('Chọn 1 người:');

        const selectRow = buildPlayerSelect('witch_poison_target', poisonTargets, 'Chọn mục tiêu...');
        const rows = Array.isArray(selectRow) ? selectRow : [selectRow];
        const poisonMsg = await safeDM(client, witch.discordId, { embeds: [poisonEmbed], components: rows });
        if (!poisonMsg) {
            game.submitWitchAction({ type: 'skip' });
            return;
        }

        const poisonChoice = await collectDMSelect(poisonMsg, game.actionTimeoutMs);
        const poisonId = poisonChoice?.startsWith('witch_poison_target_') ? poisonChoice.replace('witch_poison_target_', '') : poisonChoice;

        if (poisonId && game.players.has(poisonId)) {
            game.submitWitchAction({ type: 'poison', target: poisonId });
            const pName = game.players.get(poisonId).displayName;
            await poisonMsg.edit({
                content: `Đã đầu độc: **${pName}**`,
                embeds: [], components: [],
            });
            appendLog(game, '💜', `Phù thủy đầu độc **${pName}**`);
        } else {
            game.submitWitchAction({ type: 'skip' });
            await poisonMsg.edit({ content: 'Hết thời gian — bỏ qua.', embeds: [], components: [] });
            appendLog(game, '💜', `Phù thủy bỏ qua đầu độc (timeout)`);
        }
    } else {
        game.submitWitchAction({ type: 'skip' });
        if (dmMsg) await dmMsg.edit({ content: 'Đã bỏ qua.', embeds: [], components: [] }).catch(() => {});
        appendLog(game, '💜', `Phù thủy bỏ qua (skip/timeout)`);
    }
}

// ── Day Phase ───────────────────────────────────────────────

async function announceNightResult(game, channel, client, deaths, _saved, halfWolfBitten, nightResult) {
    // Per spec: only say "Đêm qua [tên] đã chết." per death, or "Đêm qua không
    // có người tử vong." No cause, no "được cứu" line.

    // Dedupe by discordId (couple chain may include same id twice; shouldn't,
    // but defensive)
    const uniqueDeathIds = [];
    const seen = new Set();
    for (const d of deaths) {
        if (!seen.has(d.discordId)) { seen.add(d.discordId); uniqueDeathIds.push(d.discordId); }
    }

    let desc;
    if (uniqueDeathIds.length === 0) {
        desc = 'Một đêm êm đềm trôi qua. Ngày mới bắt đầu mà không có tin xấu.';
    } else {
        const names = uniqueDeathIds.map(id => `**${game.players.get(id)?.displayName || '???'}**`).join(', ');
        desc = `Ngày mới đã đến. Đáng tiếc phải thông báo rằng: đêm qua đã xảy ra một vụ án mạng thảm khốc. Mọi người nhanh chóng phát hiện ra ${names} đã qua đời không rõ lí do.`;
    }

    const embed = new EmbedBuilder()
        .setColor(uniqueDeathIds.length > 0 ? 0xef4444 : 0x4ade80)
        .setTitle(`Kết quả Đêm ${game.round}`)
        .setDescription(desc);

    await channel.send({ embeds: [embed] });

    // Half wolf bitten → private DM to wolf team + half wolf (secretly)
    if (halfWolfBitten) {
        const transformed = [...game.players.values()].find(p => p.role === ROLE.HALF_WOLF && p.transformed);
        if (transformed) {
            const wolfTeam = [...game.players.values()].filter(p => p.alive && isWolfTeam(p));
            for (const w of wolfTeam) {
                await safeDM(client, w.discordId, {
                    embeds: [new EmbedBuilder()
                        .setColor(0x8b0000)
                        .setTitle('🐺 Bán sói hóa sói!')
                        .setDescription(`**${transformed.displayName}** vừa bị cắn và đã hóa thành Sói — đồng minh phe sói!`)]
                });
            }
            // BUG #18 FIX: list đồng đội sói hiện tại để bán sói biết ai là sói
            const currentWolfMates = [...game.players.values()]
                .filter(p => p.alive && isWolfTeam(p) && p.discordId !== transformed.discordId)
                .map(p => p.displayName)
                .join(', ');
            const wolfMatesNote = currentWolfMates
                ? `\n\nĐồng đội sói hiện tại: **${currentWolfMates}**`
                : '';
            await safeDM(client, transformed.discordId, {
                embeds: [new EmbedBuilder()
                    .setColor(0x8b0000)
                    .setTitle('🐺 Bạn đã hóa sói!')
                    .setDescription(
                        'Bạn bị sói cắn đêm nay. Vì là Bán sói, bạn không chết mà trở thành Sói thật — từ đêm sau bạn sẽ đi theo phe sói.'
                        + wolfMatesNote
                    )]
            });
        }
    }

    // Couple 3rd-party flip (bán sói hóa mid-game) → notify partner once
    if (nightResult && nightResult.coupleFlippedToThirdParty && game.cupidCouple) {
        const [aId, bId] = game.cupidCouple;
        const a = game.players.get(aId);
        const b = game.players.get(bId);
        for (const p of [a, b]) {
            if (!p) continue;
            const partnerId = p.discordId === aId ? bId : aId;
            const partner = game.players.get(partnerId);
            await safeDM(client, p.discordId, {
                embeds: [new EmbedBuilder()
                    .setColor(0xff69b4)
                    .setTitle('💔 Cặp đôi trở thành phe thứ 3!')
                    .setDescription(
                        `**${partner?.displayName || '???'}** (đối phương của bạn) vừa hóa Sói.\n` +
                        'Cặp đôi của bạn giờ là **phe thứ 3** — cả 2 cùng Cupid sẽ thắng nếu cả 2 còn sống và tất cả người khác đã chết.'
                    )]
            });
        }
    }

    // BUG #15 FIX: bán sói mới hóa → add vào wolf channel permission ngay.
    // Filter getWolfChannelMembers() đúng (transformedRound < this.round),
    // nhưng trước fix này không có call site nào dùng nó sau game start.
    if (halfWolfBitten) {
        const transformed = [...game.players.values()].find(p => p.role === ROLE.HALF_WOLF && p.transformed);
        if (transformed) {
            await addWolfChannelUser(game, client, channel.guild, transformed);
        }
    }

    if (uniqueDeathIds.length > 0) {
        const deadWolfIds = uniqueDeathIds.filter(id => {
            const p = game.players.get(id);
            return p && (p.role === ROLE.WEREWOLF || p.role === ROLE.WOLF_SEER || (p.role === ROLE.HALF_WOLF && p.transformed));
        });
        if (deadWolfIds.length > 0) {
            await removeWolfChannelUsers(game, client, channel.guild, deadWolfIds);
        }
        await muteDead(game, channel, uniqueDeathIds);
    }

    const settings = getSettings(channel.guild.id);
    if (uniqueDeathIds.length > 0 && settings.deadChannelId) {
        const deadChannel = await channel.guild.channels.fetch(settings.deadChannelId).catch(() => null);
        if (deadChannel) {
            const deadNames = uniqueDeathIds.map(id => game.players.get(id)?.displayName || '???').join(', ');
            await deadChannel.send(`💀 **${deadNames}** vừa chết đêm ${game.round}. Các bạn có thể chat tại đây.`).catch(() => {});
        }
    }
}

async function runDayTalk(game, channel) {
    game.startDayTalk();

    await unlockDay(game, channel);

    const alive = game.getAlivePlayers();

    // Auto-reduce day time based on alive count
    let talkMinutes = game.dayMinutes;
    if (alive.length < 5) {
        talkMinutes = Math.max(1, game.dayMinutes - 3);
    } else if (alive.length < 7) {
        talkMinutes = Math.max(1, game.dayMinutes - 2);
    }

    let timeNote = '';
    if (talkMinutes < game.dayMinutes) {
        timeNote = ` (giảm từ ${game.dayMinutes}p do còn ít người)`;
    }

    const embed = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle(`Ngày ${game.round} — Thảo luận`)
        .setDescription(
            `Dân làng hãy thảo luận! Ai là sói?

` +
            `**Người sống (${alive.length}):**
${playerList(alive)}

` +
            `Thời gian: **${talkMinutes} phút**${timeNote}`
        )
        .setFooter({ text: 'Sau khi thảo luận xong, bot sẽ gửi DM để bỏ phiếu.' });

    await channel.send({ embeds: [embed] });
    await new Promise(r => setTimeout(r, ms(talkMinutes)));
}

async function runDayVote(game, channel, client) {
    game.startDayVote();

    const alive = game.getAlivePlayers();
    const voteTimeout = game.actionTimeoutMs;

    const voteEmbed = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle(`Ngày ${game.round} — Bỏ phiếu treo cổ`)
        .setDescription(
            'Bot đã gửi DM cho mỗi người. Hãy kiểm tra DM để bỏ phiếu!\n' +
            `Thời gian: **${Math.round(voteTimeout / 1000)} giây**`
        );

    await channel.send({ embeds: [voteEmbed] });

    const wolfSeerLocked = game.wolfSeerVoteLocked;

    const votePromises = alive.map(async (voter) => {
        // Wolf seer with vote lock → forced vote counts as a normal skip,
        // indistinguishable from any other player's "Bỏ qua" choice.
        if (wolfSeerLocked && voter.role === ROLE.WOLF_SEER) {
            game.submitDayVote(voter.discordId, 'skip');
            await safeDM(client, voter.discordId, { content: 'Sói tiên tri đã chọn soi chức năng đêm qua. Không thể bỏ phiếu treo cổ.' });
            return;
        }

        if (!game.canVote(voter.discordId)) {
            game.submitDayVote(voter.discordId, 'skip');
            return;
        }

        const targets = alive.filter(p => p.discordId !== voter.discordId);
        const options = targets.map(p => ({
            label: p.displayName,
            value: p.discordId,
        }));
        options.push({ label: 'Bỏ qua - Không chọn treo ai.', value: 'skip' });

        const embed = new EmbedBuilder()
            .setColor(0xf59e0b)
            .setTitle(`Ngày ${game.round} — Bỏ phiếu`)
            .setDescription('Thời gian thảo luận đã hết. Hãy chọn người bạn muốn treo cổ:');

        const menu = new StringSelectMenuBuilder()
            .setCustomId('day_vote')
            .setPlaceholder('Chọn người để treo cổ...')
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(menu);
        const dmMsg = await safeDM(client, voter.discordId, { embeds: [embed], components: [row] });
        if (!dmMsg) {
            game.submitDayVote(voter.discordId, 'skip');
            return;
        }

        const choice = await collectDMSelect(dmMsg, voteTimeout);
        if (choice && (game.players.has(choice) || choice === 'skip')) {
            game.submitDayVote(voter.discordId, choice);
            const label = choice === 'skip' ? 'Bỏ qua' : game.players.get(choice)?.displayName;
            await dmMsg.edit({ content: `Đã vote: **${label}**`, embeds: [], components: [] });
        } else {
            game.submitDayVote(voter.discordId, 'skip');
            await dmMsg.edit({ content: 'Hết thời gian — tự động bỏ qua.', embeds: [], components: [] }).catch(() => {});
        }
    });

    await Promise.all(votePromises);

    const { hanged, tally, foolWin, foolId } = game.resolveDayVote();

    let resultDesc = '**Kết quả bỏ phiếu:**\n\n';

    const sorted = [...tally.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [targetId, entry] of sorted) {
        let targetLabel;
        if (targetId === 'skip') targetLabel = 'Bỏ qua';
        else targetLabel = game.players.get(targetId)?.displayName || '???';
        const voterNames = entry.voters.map(vid => game.players.get(vid)?.displayName || '???').join(', ');
        resultDesc += `**${targetLabel}** (${entry.count} phiếu) ← ${voterNames}\n`;
    }

    resultDesc += '\n';

    if (foolWin) {
        const fool = game.players.get(foolId);
        resultDesc += `Dân làng đã treo cổ **${fool.displayName}**... và đó là **Thằng khờ** 🃏!\n`;
        resultDesc += `**${fool.displayName}** THẮNG NGAY — cả Dân và Sói đều thua!`;
    } else if (hanged) {
        const p = game.players.get(hanged);
        resultDesc += `Dân làng đã treo cổ **${p.displayName}**!`;
    } else {
        resultDesc += 'Dân làng không thống nhất — không ai bị treo cổ.';
    }

    const resultEmbed = new EmbedBuilder()
        .setColor(foolWin ? 0xffa500 : hanged ? 0xef4444 : 0xeab308)
        .setTitle(`Kết quả bỏ phiếu — Ngày ${game.round}`)
        .setDescription(resultDesc);

    await channel.send({ embeds: [resultEmbed] });

    // Fool-win short-circuit: end game here
    if (foolWin) {
        return { hanged: null, foolWin: true, foolId };
    }

    let couplePartnerDied = null;

    if (hanged) {
        await muteDead(game, channel, [hanged]);

        // Couple chain — per spec this also can trigger the partner's hunter.
        const partnerId = game.getCouplePartner(hanged);
        if (partnerId) {
            const partner = game.players.get(partnerId);
            if (partner && partner.alive) {
                partner.alive = false;
                couplePartnerDied = partnerId;
                await channel.send({
                    embeds: [new EmbedBuilder()
                        .setColor(0xff69b4)
                        .setDescription(`💔 **${partner.displayName}** chết theo người yêu!`)]
                });
                await muteDead(game, channel, [partnerId]);
            }
        }

        const settings = getSettings(channel.guild.id);
        if (settings.deadChannelId) {
            const deadChannel = await channel.guild.channels.fetch(settings.deadChannelId).catch(() => null);
            if (deadChannel) {
                const p = game.players.get(hanged);
                await deadChannel.send(`💀 **${p.displayName}** bị treo cổ ngày ${game.round}. Bạn có thể chat tại đây.`).catch(() => {});
            }
        }
    }

    return { hanged, foolWin: false, couplePartnerDied };
}

// ── Hunter Shot ─────────────────────────────────────────────

async function runHunterShot(game, channel, client, hunterId, context = 'night') {
    const hunter = game.players.get(hunterId);
    const targets = game.getAlivePlayers();

    if (targets.length === 0) return null;

    const dmIntro = context === 'hang'
        ? 'Bạn sắp bị đưa lên giàn treo cổ. Có muốn dùng chức năng bắn chết ai để làm đệm lưng cho mình không?'
        : 'Đêm nay bạn đã chết. Bạn có muốn dùng chức năng bắn chết ai để làm đệm lưng cho mình không?';

    const embed = new EmbedBuilder()
        .setColor(0xff6600)
        .setTitle('Thợ săn — Chọn người để bắn (hoặc bỏ qua)')
        .setDescription(dmIntro);

    const skipBtn = new ButtonBuilder()
        .setCustomId('hunter_skip')
        .setLabel('Không bắn')
        .setStyle(ButtonStyle.Secondary);

    const selectRow = buildPlayerSelect('hunter_shot', targets, 'Chọn mục tiêu...');
    const rows = Array.isArray(selectRow) ? selectRow : [selectRow];
    const buttonRow = new ActionRowBuilder().addComponents(skipBtn);
    const dmMsg = await safeDM(client, hunterId, { embeds: [embed], components: [...rows, buttonRow] });

    let shotTargetId = null;
    let skipped = false;

    if (dmMsg) {
        const choice = await collectDMSelect(dmMsg, game.actionTimeoutMs);
        if (choice === 'hunter_skip') {
            skipped = true;
            await dmMsg.edit({ content: 'Đã chọn không bắn ai.', embeds: [], components: [] });
        } else {
            shotTargetId = choice?.startsWith('hunter_shot_') ? choice.replace('hunter_shot_', '') : choice;
            if (!shotTargetId || !game.players.has(shotTargetId)) {
                shotTargetId = targets[Math.floor(Math.random() * targets.length)].discordId;
            }
            await dmMsg.edit({ content: `Đã bắn: **${game.players.get(shotTargetId).displayName}**`, embeds: [], components: [] }).catch(() => {});
        }
    } else {
        skipped = true; // no DM = default skip
    }

    if (skipped || !shotTargetId) {
        await channel.send({
            embeds: [new EmbedBuilder()
                .setColor(0xff6600)
                .setDescription(`**${hunter.displayName}** là... Thợ săn. Trước khi chết ${hunter.displayName} chọn không kéo ai chết cùng mình.`)],
        });
        return null;
    }

    const killed = game.executeHunterShot(shotTargetId);
    if (killed) {
        await channel.send({
            embeds: [new EmbedBuilder()
                .setColor(0xef4444)
                .setDescription(`**${hunter.displayName}** ... là Thợ săn. Trước khi chết, **${hunter.displayName}** đã giương súng lên và nhắm vào **${killed.displayName}**. **ĐOÀNG!** **${killed.displayName}** đã bị **${hunter.displayName}** bắn chết!`)],
        });
        await muteDead(game, channel, [killed.discordId]);

        // Couple chain: if killed is a couple member, partner dies cause='couple'
        const partnerId = game.getCouplePartner(killed.discordId);
        if (partnerId) {
            const partner = game.players.get(partnerId);
            if (partner && partner.alive) {
                partner.alive = false;
                await channel.send({
                    embeds: [new EmbedBuilder()
                        .setColor(0xff69b4)
                        .setDescription(`💔 **${partner.displayName}** chết theo người yêu!`)]
                });
                await muteDead(game, channel, [partnerId]);

                // Per spec, a shot death can chain into another hunter.
                const chainedHunter = game.checkHunterDeath(partnerId);
                if (chainedHunter) {
                    await runHunterShot(game, channel, client, partnerId, context);
                }
            }
        }
    }

    return killed;
}

// ── Main Game Loop ──────────────────────────────────────────

async function runGameLoop(game, channel, client) {
    game.assignRoles();

    const roleMessages = [...game.players.values()].map(async (p) => {
        let desc = `**Vai của bạn: ${getDisplayRole(p)}**\n\n${ROLE_DESC[p.role]}`;

        // Sói / Sói tiên tri / Bán sói đã hóa → biết đồng đội sói
        if (isWolfTeam(p)) {
            const wolfMates = game.getWolfIds().filter(id => id !== p.discordId);
            if (wolfMates.length > 0) {
                const names = wolfMates.map(id => game.players.get(id)?.displayName || '???').join(', ');
                desc += `\n\nĐồng đội sói: **${names}**`;
            }
        }

        // Cupid role message reminder
        if (p.role === ROLE.CUPID) {
            desc += `\n\nBạn sẽ được DM ở đêm 1 để ghép đôi.`;
        }

        const embed = new EmbedBuilder()
            .setColor(
                p.role === ROLE.WEREWOLF ? 0x8b0000
                : p.role === ROLE.WOLF_SEER ? 0x660000
                : p.role === ROLE.HALF_WOLF ? 0x4a0000
                : 0x7c3aed
            )
            .setTitle("SLTĐ's Ma Sói — Vai trò của bạn")
            .setDescription(desc)
            .setFooter({ text: 'Giữ bí mật vai trò của bạn!' });

        await safeDM(client, p.discordId, { embeds: [embed] });
    });

    await Promise.all(roleMessages);

    // Khoá kênh game: @everyone không chat được, chỉ player mới có quyền
    await lockGameChannel(game, channel);
    // Đảm bảo kênh mồ mả có permission cho role Vong
    await setupDeadChannelPermissions(channel.guild);

    // Grant wolves access to the dedicated wolf channel (if configured)
    await setupWolfChannelAccess(game, client, channel.guild);

    const settings = getSettings(channel.guild.id);
    let deadChannelNote = '';
    if (settings.deadChannelId) {
        deadChannelNote = `\nKênh chat người chết: <#${settings.deadChannelId}>`;
    }

    const startEmbed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle("SLTĐ's Ma Sói — Game bắt đầu!")
        .setDescription(
            `Đã phân vai cho **${game.players.size} người chơi**. Kiểm tra DM!\n\n` +
            `Thời gian ngày: **${game.dayMinutes} phút**` +
            deadChannelNote
        )
        .setFooter({ text: "SLTĐ's Bot" });

    await channel.send({ embeds: [startEmbed] });

    while (true) {
        const nightResult = await runNight(game, channel, client);
        const { deaths, halfWolfBitten } = nightResult;

        // 1. Announce night deaths to public (zero-leak format).
        await announceNightResult(game, channel, client, deaths, [], halfWolfBitten, nightResult);

        // 2. Hunter triggers regardless of cause of death (bite, poison, or
        // couple chain) — each death is checked once and a dead player can't
        // die twice, so this can't double-fire.
        for (const d of deaths) {
            const hunter = game.checkHunterDeath(d.discordId);
            if (hunter) {
                await runHunterShot(game, channel, client, d.discordId, 'night');
            }
        }

        let win = game.checkWin();
        if (win) return await endGame(game, channel, client);

        await runDayTalk(game, channel);
        const voteResult = await runDayVote(game, channel, client);

        // Fool-win short-circuit
        if (voteResult.foolWin) {
            return await endGame(game, channel, client);
        }

        // Hang hunter trigger, and the couple partner pulled down with them.
        if (voteResult.hanged) {
            const hunter = game.checkHunterDeath(voteResult.hanged);
            if (hunter) {
                await runHunterShot(game, channel, client, voteResult.hanged, 'hang');
            }
        }
        if (voteResult.couplePartnerDied) {
            const hunter = game.checkHunterDeath(voteResult.couplePartnerDied);
            if (hunter) {
                await runHunterShot(game, channel, client, voteResult.couplePartnerDied, 'hang');
            }
        }

        win = game.checkWin();
        if (win) return await endGame(game, channel, client);
    }
}

async function endGame(game, channel, client) {
    game.state = STATE.GAME_OVER;

    await cleanupPermissions(game, channel);
    if (client) await cleanupWolfChannelAccess(game, client, channel.guild);

    const winners = game.getWinners();

    // Determine title + color from winner type
    let title, color, winTeam;
    if (game.winner === WINNER.FOOL) {
        title = 'Game Over — Thằng khờ thắng!';
        color = 0xffa500;
        winTeam = 'Thằng khờ 🃏';
    } else if (game.winner === WINNER.COUPLE) {
        title = 'Game Over — Phe thứ 3 (Cặp đôi + Cupid) thắng!';
        color = 0xff69b4;
        winTeam = 'Cặp đôi + Cupid 💕';
    } else if (game.winner === WINNER.VILLAGE) {
        title = 'Game Over — Phe Dân thắng!';
        color = 0x4ade80;
        winTeam = 'Phe Dân';
    } else {
        title = 'Game Over — Phe Sói thắng!';
        color = 0x8b0000;
        winTeam = 'Phe Sói';
    }

    // Update scores
    const guildId = channel.guild.id;
    const allIds = [...game.players.keys()];
    const loserIds = allIds.filter(id => !winners.includes(id));
    updateScores(guildId, winners, loserIds, game.players);

    const allPlayers = [...game.players.values()];
    const roleReveal = allPlayers.map(p => {
        const status = p.alive ? '✅' : '💀';
        const winMark = winners.includes(p.discordId) ? ' 🏆' : '';
        return `${status} **${p.displayName}** — ${getDisplayRole(p)}${winMark}`;
    }).join('\n');

    let coupleNote = '';
    if (game.cupidCouple) {
        const n1 = game.players.get(game.cupidCouple[0])?.displayName || '???';
        const n2 = game.players.get(game.cupidCouple[1])?.displayName || '???';
        const crossFlag = isCrossFactionCouple(game) ? ' (phe thứ 3)' : '';
        coupleNote = `\n\n💕 Cặp đôi Cupid: **${n1}** & **${n2}**${crossFlag}`;
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(
            `Sau **${game.round} đêm**, trò chơi kết thúc!\n\n` +
            `🏆 **${winTeam}** chiến thắng.\n\n` +
            `**Danh sách vai trò:**\n${roleReveal}` +
            coupleNote
        )
        .setFooter({ text: "SLTĐ's Bot" });

    await channel.send({ embeds: [embed] });

    // ── Log hoạt động ban đêm (tổng hợp tất cả các đêm) ──
    if (game.nightLog && game.nightLog.length > 0) {
        const logLines = [];
        for (const night of game.nightLog) {
            logLines.push(`**Đêm ${night.round}:**`);
            if (night.entries.length === 0) {
                logLines.push('_(không có hành động nào)_');
            } else {
                for (const e of night.entries) logLines.push(`${e.icon} ${e.text}`);
            }
            logLines.push('');
        }
        const logText = logLines.join('\n').trim();
        const MAX = 3800;
        const chunks = [];
        if (logText.length <= MAX) chunks.push(logText);
        else {
            let buf = '';
            for (const line of logLines) {
                if ((buf + '\n' + line).length > MAX) {
                    chunks.push(buf);
                    buf = line;
                } else {
                    buf = buf ? buf + '\n' + line : line;
                }
            }
            if (buf) chunks.push(buf);
        }
        for (let i = 0; i < chunks.length; i++) {
            const logEmbed = new EmbedBuilder()
                .setColor(0x6b7280)
                .setTitle(chunks.length > 1 ? `📋 Log hoạt động (${i + 1}/${chunks.length})` : '📋 Log hoạt động ban đêm')
                .setDescription(chunks[i])
                .setFooter({ text: "SLTĐ's Bot" });
            await channel.send({ embeds: [logEmbed] });
        }
    }
}

// ── Slash Command ───────────────────────────────────────────

module.exports = {
    data: new SlashCommandBuilder()
        .setName('masoi')
        .setDescription("SLTĐ's Ma Sói (Werewolf)")
        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Cài đặt Ma Sói cho server (Admin)')
                .addChannelOption(opt =>
                    opt.setName('game_channel')
                        .setDescription('Kênh chơi Ma Sói')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false))
                .addChannelOption(opt =>
                    opt.setName('dead_channel')
                        .setDescription('Kênh chat cho người chết (có role sayonara)')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false))
                .addChannelOption(opt =>
                    opt.setName('wolf_channel')
                        .setDescription('Kênh chat riêng cho phe Sói (mỗi game bot add/remove user tự động)')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false))
                .addIntegerOption(opt =>
                    opt.setName('day')
                        .setDescription('Thời gian ngày (phút, mặc định 5)')
                        .setMinValue(1).setMaxValue(15).setRequired(false))
                .addIntegerOption(opt =>
                    opt.setName('action_seconds')
                        .setDescription('Thời gian mỗi chức năng đêm + vote treo cổ (giây, mặc định 60)')
                        .setMinValue(15).setMaxValue(180).setRequired(false))
                .addIntegerOption(opt =>
                    opt.setName('wolf_vote_seconds')
                        .setDescription('Thời gian Sói vote cắn (giây, mặc định 90)')
                        .setMinValue(15).setMaxValue(180).setRequired(false))
                .addIntegerOption(opt =>
                    opt.setName('cupid_seconds')
                        .setDescription('Thời gian Cupid ghép đôi đêm 1 (giây, mặc định 180)')
                        .setMinValue(30).setMaxValue(600).setRequired(false))
                .addBooleanOption(opt =>
                    opt.setName('night_progress_dm')
                        .setDescription('Gửi DM "... đã hoàn thành chức năng." sau mỗi vai trong đêm (mặc định bật)')
                        .setRequired(false))
        )
        .addSubcommand(sub =>
            sub.setName('play')
                .setDescription('Tạo lobby Ma Sói'))
        .addSubcommand(sub =>
            sub.setName('start')
                .setDescription('Bắt đầu ván Ma Sói (Admin/Host)'))
        .addSubcommand(sub =>
            sub.setName('stop')
                .setDescription('Dừng ván Ma Sói (Admin/Host)'))
        .addSubcommand(sub =>
            sub.setName('settings')
                .setDescription('Xem cài đặt hiện tại'))
        .addSubcommand(sub =>
            sub.setName('top')
                .setDescription('Bảng xếp hạng Ma Sói'))
        .addSubcommand(sub =>
            sub.setName('score')
                .setDescription('Xem điểm Ma Sói')
                .addUserOption(opt =>
                    opt.setName('user')
                        .setDescription('Người muốn xem điểm')
                        .setRequired(false))),

    async execute(interaction, client) {
        const sub = interaction.options.getSubcommand();
        const config = client.config;
        const guildId = interaction.guild.id;

        // ── /masoi setup ────────────────────────────────
        if (sub === 'setup') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: 'Bạn cần quyền **Manage Server** để setup.', flags: MessageFlags.Ephemeral });
            }

            await interaction.deferReply();

            const settings = getSettings(guildId);
            const gameChannel = interaction.options.getChannel('game_channel');
            const deadChannel = interaction.options.getChannel('dead_channel');
            const wolfChannel = interaction.options.getChannel('wolf_channel');
            const day = interaction.options.getInteger('day');
            const actionSeconds = interaction.options.getInteger('action_seconds');
            const wolfVoteSeconds = interaction.options.getInteger('wolf_vote_seconds');
            const cupidSeconds = interaction.options.getInteger('cupid_seconds');
            const nightProgressDm = interaction.options.getBoolean('night_progress_dm');

            if (gameChannel) settings.gameChannelId = gameChannel.id;
            if (deadChannel) settings.deadChannelId = deadChannel.id;
            if (wolfChannel) settings.wolfChannelId = wolfChannel.id;
            if (day) settings.dayMinutes = day;
            if (actionSeconds) settings.actionSeconds = actionSeconds;
            if (wolfVoteSeconds) settings.wolfVoteSeconds = wolfVoteSeconds;
            if (cupidSeconds) settings.cupidSeconds = cupidSeconds;
            if (nightProgressDm !== null) settings.nightProgressDm = nightProgressDm;

            if (deadChannel) {
                try {
                    const role = await findOrCreateSayonaraRole(interaction.guild);

                    await deadChannel.permissionOverwrites.edit(interaction.guild.id, {
                        SendMessages: false,
                    });
                    await deadChannel.permissionOverwrites.edit(role.id, {
                        ViewChannel: true,
                        SendMessages: true,
                        AddReactions: true,
                        ReadMessageHistory: true,
                    });
                } catch (e) {
                    console.error('[masoi] setup dead channel fail:', e.message);
                }
            }

            // Wolf channel: hide from @everyone so only added users can see.
            if (wolfChannel) {
                try {
                    await wolfChannel.permissionOverwrites.edit(interaction.guild.id, {
                        ViewChannel: false,
                    });
                } catch (e) {
                    console.error('[masoi] setup wolf channel fail:', e.message);
                }
            }

            const embed = new EmbedBuilder()
                .setColor(config.colors.success)
                .setTitle("SLTĐ's Ma Sói — Cài đặt đã lưu")
                .setDescription(
                    `Kênh chơi: ${settings.gameChannelId ? `<#${settings.gameChannelId}>` : '_chưa set_'}\n` +
                    `Kênh người chết: ${settings.deadChannelId ? `<#${settings.deadChannelId}>` : '_chưa set_'}\n` +
                    `Kênh phòng sói: ${settings.wolfChannelId ? `<#${settings.wolfChannelId}>` : '_chưa set_'}\n` +
                    `Thời gian ngày: **${settings.dayMinutes} phút**\n` +
                    `Thời gian chức năng đêm + vote treo cổ: **${settings.actionSeconds}s**\n` +
                    `Thời gian Sói vote cắn: **${settings.wolfVoteSeconds}s**\n` +
                    `Thời gian Cupid đêm 1: **${settings.cupidSeconds}s**\n` +
                    `DM tiến độ đêm: **${settings.nightProgressDm ? 'Bật' : 'Tắt'}**\n\n` +
                    `Role người chết: **${SAYONARA_ROLE_NAME}** (auto tạo)`
                )
                .setFooter({ text: "SLTĐ's Bot" });

            return interaction.editReply({ embeds: [embed] });
        }

        // ── /masoi settings ─────────────────────────────
        if (sub === 'settings') {
            const settings = getSettings(guildId);
            const embed = new EmbedBuilder()
                .setColor(config.colors.accent)
                .setTitle("SLTĐ's Ma Sói — Cài đặt hiện tại")
                .setDescription(
                    `Kênh chơi: ${settings.gameChannelId ? `<#${settings.gameChannelId}>` : '_chưa set (dùng kênh hiện tại)_'}\n` +
                    `Kênh người chết: ${settings.deadChannelId ? `<#${settings.deadChannelId}>` : '_chưa set_'}\n` +
                    `Kênh phòng sói: ${settings.wolfChannelId ? `<#${settings.wolfChannelId}>` : '_chưa set_'}\n` +
                    `Thời gian ngày: **${settings.dayMinutes} phút**\n` +
                    `Thời gian chức năng đêm + vote treo cổ: **${settings.actionSeconds}s**\n` +
                    `Thời gian Sói vote cắn: **${settings.wolfVoteSeconds}s**\n` +
                    `Thời gian Cupid đêm 1: **${settings.cupidSeconds}s**\n` +
                    `DM tiến độ đêm: **${settings.nightProgressDm ? 'Bật' : 'Tắt'}**\n` +
                    `Role người chết: **${SAYONARA_ROLE_NAME}**\n` +
                    `Giới hạn: **${MIN_PLAYERS}–${MAX_PLAYERS}** người`
                )
                .setFooter({ text: 'Dùng /masoi setup để thay đổi' });

            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        // ── /masoi play ─────────────────────────────────
        if (sub === 'play') {
            const settings = getSettings(guildId);
            const gameChannelId = settings.gameChannelId || interaction.channel.id;

            if (activeGames.has(gameChannelId)) {
                return interaction.reply({ content: 'Đang có ván Ma Sói đang chạy rồi!', flags: MessageFlags.Ephemeral });
            }

            const game = new WerewolfGame(gameChannelId, interaction.user.id);
            game.dayMinutes = settings.dayMinutes;
            game.actionTimeoutMs = settings.actionSeconds * 1000;
            game.wolfVoteTimeoutMs = settings.wolfVoteSeconds * 1000;
            game.cupidTimeoutMs = settings.cupidSeconds * 1000;
            game.nightProgressDm = settings.nightProgressDm;

            activeGames.set(gameChannelId, game);

            const gameChannel = interaction.guild.channels.cache.get(gameChannelId) || interaction.channel;

            let deadInfo = '';
            if (settings.deadChannelId) {
                deadInfo = `\nKênh người chết: <#${settings.deadChannelId}> (role **${SAYONARA_ROLE_NAME}**)`;
            }

            const lobbyEmbed = new EmbedBuilder()
                .setColor(config.colors.accent)
                .setTitle("SLTĐ's Ma Sói — Lobby")
                .setDescription(
                    `Host: ${interaction.user}\n` +
                    `Thời gian ngày: **${game.dayMinutes}p**` +
                    deadInfo + `\n\n` +
                    `Cần tối thiểu **${MIN_PLAYERS}** người (tối đa ${MAX_PLAYERS}).\n` +
                    `Bấm nút bên dưới để tham gia!\n\n` +
                    `**Người chơi (0):**\n_Chưa có ai_`
                )
                .setFooter({ text: 'Admin dùng /masoi start khi đủ người' });

            const joinBtn = new ButtonBuilder()
                .setCustomId('masoi_join')
                .setLabel('Tham gia')
                .setStyle(ButtonStyle.Success);

            const leaveBtn = new ButtonBuilder()
                .setCustomId('masoi_leave')
                .setLabel('Rời')
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder().addComponents(joinBtn, leaveBtn);

            let lobbyMsg;
            if (gameChannelId !== interaction.channel.id) {
                await interaction.reply({ content: `Lobby đã tạo tại <#${gameChannelId}>!`, flags: MessageFlags.Ephemeral });
                lobbyMsg = await gameChannel.send({ embeds: [lobbyEmbed], components: [row] });
            } else {
                lobbyMsg = await interaction.reply({ embeds: [lobbyEmbed], components: [row], fetchReply: true });
            }

            const collector = lobbyMsg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 24 * 60 * 60_000,  // FIX #2: 24h instead of 5min (was killing active lobbies)
            });

            collector.on('collect', async (btnInteraction) => {
                const g = activeGames.get(gameChannelId);
                if (!g) {
                    collector.stop();
                    return;
                }
                if (g.state !== STATE.LOBBY) {
                    // FIX #6: reply ephemeral so user knows why button did nothing
                    try {
                        await btnInteraction.reply({ content: 'Game đã bắt đầu, không thể thay đổi lobby.', flags: MessageFlags.Ephemeral });
                    } catch {}
                    collector.stop();
                    return;
                }

                if (btnInteraction.customId === 'masoi_join') {
                    const result = g.addPlayer(
                        btnInteraction.user.id,
                        btnInteraction.member?.displayName || btnInteraction.user.username
                    );

                    if (!result.ok) {
                        const reasons = {
                            already_joined: 'Bạn đã tham gia rồi!',
                            full: 'Lobby đã đầy!',
                            not_lobby: 'Game đã bắt đầu!',
                        };
                        return btnInteraction.reply({ content: reasons[result.reason], flags: MessageFlags.Ephemeral });
                    }

                    const players = [...g.players.values()];
                    const list = players.map((p, i) => `${i + 1}. ${p.displayName}`).join('\n');

                    const updated = EmbedBuilder.from(lobbyMsg.embeds[0])
                        .setDescription(
                            `Host: <@${g.hostId}>\n` +
                            `Thời gian ngày: **${g.dayMinutes}p**` +
                            deadInfo + `\n\n` +
                            `Cần tối thiểu **${MIN_PLAYERS}** người (tối đa ${MAX_PLAYERS}).\n` +
                            `Bấm nút bên dưới để tham gia!\n\n` +
                            `**Người chơi (${players.length}):**\n${list}`
                        );

                    await btnInteraction.update({ embeds: [updated] });
                }

                if (btnInteraction.customId === 'masoi_leave') {
                    const result = g.removePlayer(btnInteraction.user.id);
                    if (!result.ok) {
                        return btnInteraction.reply({ content: 'Bạn không trong lobby!', flags: MessageFlags.Ephemeral });
                    }

                    const players = [...g.players.values()];
                    const list = players.length > 0
                        ? players.map((p, i) => `${i + 1}. ${p.displayName}`).join('\n')
                        : '_Chưa có ai_';

                    const updated = EmbedBuilder.from(lobbyMsg.embeds[0])
                        .setDescription(
                            `Host: <@${g.hostId}>\n` +
                            `Thời gian ngày: **${g.dayMinutes}p**` +
                            deadInfo + `\n\n` +
                            `Cần tối thiểu **${MIN_PLAYERS}** người (tối đa ${MAX_PLAYERS}).\n` +
                            `Bấm nút bên dưới để tham gia!\n\n` +
                            `**Người chơi (${players.length}):**\n${list}`
                        );

                    await btnInteraction.update({ embeds: [updated] });
                }
            });

            collector.on('end', () => {
                const g = activeGames.get(gameChannelId);
                if (g && g.state === STATE.LOBBY) {
                    activeGames.delete(gameChannelId);
                    lobbyMsg.edit({ components: [] }).catch(() => {});
                }
            });

            return;
        }

        // ── /masoi start ────────────────────────────────
        if (sub === 'start') {
            const settings = getSettings(guildId);
            const gameChannelId = settings.gameChannelId || interaction.channel.id;
            const game = activeGames.get(gameChannelId);

            if (!game) {
                return interaction.reply({ content: 'Chưa có lobby Ma Sói. Dùng `/masoi play` trước.', flags: MessageFlags.Ephemeral });
            }

            const isHost = game.hostId === interaction.user.id;
            const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
            if (!isHost && !isAdmin) {
                return interaction.reply({ content: 'Chỉ host hoặc admin mới bắt đầu được.', flags: MessageFlags.Ephemeral });
            }

            if (!game.canStart()) {
                return interaction.reply({
                    content: `Cần ít nhất **${MIN_PLAYERS}** người. Hiện có: **${game.players.size}**.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            // FIX #5: atomic guard against double-start race
            if (game.state !== STATE.LOBBY) {
                return interaction.reply({ content: 'Game đã bắt đầu rồi!', flags: MessageFlags.Ephemeral });
            }
            game.state = STATE.NIGHT;

            const gameChannel = interaction.guild.channels.cache.get(gameChannelId) || interaction.channel;

            await interaction.reply({ content: 'Game bắt đầu! Đang phân vai...' });

            try {
                await runGameLoop(game, gameChannel, client);
            } catch (err) {
                console.error('[masoi]', err);
                await cleanupPermissions(game, gameChannel);
                await gameChannel.send('Có lỗi xảy ra, game kết thúc.').catch(() => {});
            } finally {
                activeGames.delete(gameChannelId);
            }

            return;
        }

        // ── /masoi stop ─────────────────────────────────
        // ── /masoi top ──────────────────────────────
        // ── /masoi stop (FIX #1: moved before top/score to fix dead code) ─

        if (sub === 'stop') {
            // Admin-only for standalone mode (no game = no host)
            const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
            if (!isAdmin) {
                return interaction.reply({ content: 'Chỉ admin mới chạy được `/masoi stop`.', flags: MessageFlags.Ephemeral });
            }

            // FIX #13: deferReply first — cleanup may exceed Discord's 3s interaction timeout
            await interaction.deferReply();

            const settings = getSettings(guildId);
            const gameChannelId = settings.gameChannelId || interaction.channel.id;
            const game = activeGames.get(gameChannelId);

            // MODE A: có game active → stop game + cleanup game state
            if (game) {
                game.state = STATE.GAME_OVER;
                activeGames.delete(gameChannelId);

                const gameChannel = interaction.guild.channels.cache.get(gameChannelId) || interaction.channel;

                // FIX #12: full cleanup — restore channel perms + remove sayonara + wolf channel access
                await cleanupPermissions(game, gameChannel);
                await cleanupWolfChannelAccess(game, client, gameChannel.guild);

                const allPlayers = [...game.players.values()];
                const roleReveal = allPlayers.map(p => {
                    const status = p.alive ? '✅' : '💀';
                    return `${status} **${p.displayName}** — ${ROLE_LABEL[p.role] || '???'}`;
                }).join('\n');

                const embed = new EmbedBuilder()
                    .setColor(config.colors.warning)
                    .setTitle("SLTĐ's Ma Sói — Game bị dừng")
                    .setDescription(
                        `Game đã bị dừng bởi ${interaction.user}.\n\n` +
                        `**Đã cleanup:** toàn bộ permission override, sayonara role, kênh phòng sói.\n\n` +
                        `**Danh sách vai trò:**\n${roleReveal}`
                    );

                return interaction.editReply({ embeds: [embed] });
            }

            // MODE B: không có game → standalone cleanup toàn guild
            const stats = await cleanupGuildFully(interaction.guild);

            const gameInfo = stats.gameChannel
                ? `• Kênh game <#${settings.gameChannelId}>: gỡ **${stats.gameChannel.cleaned}** override, ${stats.gameChannel.everyoneRestored ? '@everyone đã trả lại' : '@everyone không có override'}`
                : '• Kênh game: chưa set';
            const wolfInfo = stats.wolfChannel
                ? `• Phòng sói <#${settings.wolfChannelId}>: gỡ **${stats.wolfChannel.dropped}** override user, @everyone ViewChannel:false giữ nguyên (private)`
                : '• Phòng sói: chưa set';
            const deadInfo = stats.deadChannel
                ? `• Kênh dead <#${settings.deadChannelId}>: gỡ **${stats.deadChannel.dropped}** override user, role sayonara + @everyone SendMessages:false giữ nguyên (private)`
                : '• Kênh dead: chưa set';

            const embed = new EmbedBuilder()
                .setColor(config.colors.warning)
                .setTitle("SLTĐ's Ma Sói — Standalone Cleanup")
                .setDescription(
                    `Không có game đang chạy. Đã dọn dẹp override cũ trên 3 channel Ma Sói quản lý.\n\n` +
                    `**Scope:** chỉ chạm gameChannelId, wolfChannelId, deadChannelId. Channel khác bot không động vào.\n\n` +
                    `**Kết quả:**\n${gameInfo}\n${wolfInfo}\n${deadInfo}\n` +
                    `• Member đã gỡ role sayonara: **${stats.sayonaraRemoved}**\n\n` +
                    `Bởi: ${interaction.user}`
                )
                .setFooter({ text: 'Bot không động vào channel khác trong guild — chỉ 3 channel đã setup' });

            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'top') {
            const scores = loadScores(guildId);
            const sorted = Object.entries(scores)
                .sort((a, b) => b[1].score - a[1].score)
                .slice(0, 15);

            if (sorted.length === 0) {
                return interaction.reply({ content: 'Chưa có ai chơi Ma Sói trong server này.', flags: MessageFlags.Ephemeral });
            }

            const list = sorted.map(([id, data], i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                const sign = data.score >= 0 ? '+' : '';
                return `${medal} **${data.name}** — ${sign}${data.score} điểm (${data.wins}W/${data.losses}L)`;
            }).join('\n');

            const embed = new EmbedBuilder()
                .setColor(config.colors.accent)
                .setTitle("🏆 SLTĐ's Ma Sói — Bảng Xếp Hạng")
                .setDescription(list)
                .setFooter({ text: `Tổng ${Object.keys(scores).length} người chơi` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        // ── /masoi score ────────────────────────────
        if (sub === 'score') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const scores = loadScores(guildId);
            const data = scores[targetUser.id];

            if (!data) {
                return interaction.reply({
                    content: targetUser.id === interaction.user.id
                        ? 'Bạn chưa chơi Ma Sói trong server này.'
                        : `**${targetUser.displayName}** chưa chơi Ma Sói trong server này.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const sorted = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
            const rank = sorted.findIndex(([id]) => id === targetUser.id) + 1;

            const sign = data.score >= 0 ? '+' : '';
            const embed = new EmbedBuilder()
                .setColor(config.colors.accent)
                .setTitle(`Ma Sói — Điểm của ${data.name}`)
                .setDescription(
                    `Điểm: **${sign}${data.score}**\n` +
                    `Thắng: **${data.wins}** | Thua: **${data.losses}**\n` +
                    `Tổng ván: **${data.games}**\n` +
                    `Xếp hạng: **#${rank}** / ${sorted.length}`
                )
                .setFooter({ text: "SLTĐ's Bot" });

            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
    },
};
