/**
 * Werewolf (Ma Sói) Game Engine
 *
 * Pure game logic — no Discord API calls. The command file (werewolf.js)
 * handles all Discord interactions and calls into this service.
 *
 * State machine: LOBBY → NIGHT → DAY_TALK → DAY_VOTE → (win check) → NIGHT …
 *
 * Rework 2026-06-19: 2 new roles (Sói tiên tri, Tiên tri tập sự), Bán sói hóa
 * sói thật, Cupid/cặp đôi 3 trường hợp ghép, Thằng khờ treo = thắng, Quản
 * ngục = bảo vệ, Phù thủy kamikaze + tự cứu, Thợ săn skip + chỉ wolf/hang.
 */

// ── Roles ───────────────────────────────────────────────────

const ROLE = {
    VILLAGER: 'villager',
    WEREWOLF: 'werewolf',
    WOLF_SEER: 'wolf_seer',
    SEER: 'seer',
    APPRENTICE_SEER: 'apprentice_seer',
    GUARD: 'guard',
    HUNTER: 'hunter',
    WITCH: 'witch',
    CUPID: 'cupid',
    HALF_WOLF: 'half_wolf',
    JAILER: 'jailer',
    FOOL: 'fool',
};

const ROLE_LABEL = {
    [ROLE.VILLAGER]: 'Dân làng',
    [ROLE.WEREWOLF]: 'Sói',
    [ROLE.WOLF_SEER]: 'Sói tiên tri',
    [ROLE.SEER]: 'Tiên tri',
    [ROLE.APPRENTICE_SEER]: 'Tiên tri tập sự',
    [ROLE.GUARD]: 'Bảo vệ',
    [ROLE.HUNTER]: 'Thợ săn',
    [ROLE.WITCH]: 'Phù thủy',
    [ROLE.CUPID]: 'Cupid',
    [ROLE.HALF_WOLF]: 'Bán sói',
    [ROLE.JAILER]: 'Quản ngục',
    [ROLE.FOOL]: 'Thằng khờ',
};

const TEAM = {
    VILLAGE: 'village',
    WOLF: 'wolf',
};

const WINNER = {
    VILLAGE: 'village',
    WOLF: 'wolf',
    COUPLE: 'couple',
    FOOL: 'fool',
};

const ROLE_TEAM = {
    [ROLE.VILLAGER]: TEAM.VILLAGE,
    [ROLE.WEREWOLF]: TEAM.WOLF,
    [ROLE.WOLF_SEER]: TEAM.WOLF,
    [ROLE.SEER]: TEAM.VILLAGE,
    [ROLE.APPRENTICE_SEER]: TEAM.VILLAGE,
    [ROLE.GUARD]: TEAM.VILLAGE,
    [ROLE.HUNTER]: TEAM.VILLAGE,
    [ROLE.WITCH]: TEAM.VILLAGE,
    [ROLE.CUPID]: TEAM.VILLAGE, // flips to neutral if 3rd-party couple
    [ROLE.HALF_WOLF]: TEAM.VILLAGE, // flips to WOLF after transform
    [ROLE.JAILER]: TEAM.VILLAGE,
    [ROLE.FOOL]: TEAM.VILLAGE, // 3rd-party sole winner
};

const ROLE_DESC = {
    [ROLE.VILLAGER]: 'Bạn là dân làng. Hãy tìm ra sói và vote treo cổ chúng vào ban ngày!',
    [ROLE.WEREWOLF]: 'Mỗi đêm sẽ chọn một người để cắn chết.',
    [ROLE.WOLF_SEER]: 'Mỗi đêm có thể chọn một người để soi vai trò hoặc chọn không soi. Nếu sói tiên tri chọn soi ở đêm trước đó thì hôm sau không thể bỏ phiếu treo người. Sói tiên tri mặc định là bỏ qua vote treo cổ. Kết quả hiển thị tổng phiếu sẽ hiện là bỏ qua giống các người chơi khác. Cẩn thận bị dân nghi ngờ vì bỏ phiếu quá nhiều. Quản ngục có thể bắt giam để Sói tiên tri không thể dùng chức năng soi vai trò.',
    [ROLE.SEER]: 'Soi ra được thân phận của một người mỗi đêm. Nếu bị quản trò giam sẽ không thể dùng.',
    [ROLE.APPRENTICE_SEER]: 'Chỉ khi tiên tri vip pro hẹo mới có thể dùng khả năng tiên tri (chỉ soi được phe của dân. Phe thứ ba/neutral/sói đều hiện không soi được). Quản ngục giam sẽ không thể soi.',
    [ROLE.GUARD]: 'Sẽ chọn ra một người để bảo vệ, nếu đêm đó người được chọn bảo vệ bị cắn thì sẽ không chết. Không được bảo vệ một người hai đêm liên tiếp. Nếu bị quản ngục giam sẽ không thể bảo vệ ai.',
    [ROLE.HUNTER]: 'Khi chết bởi sói căn/treo cổ có thể bắn chết một người cùng mình. (Có thể lựa chọn không bắn)',
    [ROLE.WITCH]: 'Có hai bình thuốc xanh và đỏ. Thuốc xanh dùng để hồi sinh một người, thuốc đỏ là dùng để giết một người. Mỗi đêm đều sẽ được thông báo: ai bị sói cắn chết -> có dùng bình xanh để cứu không; có dùng bình đỏ lên ai không. Nếu bị sói cắn chết có thể dùng thuốc xanh để tự hồi sinh mình, nếu hết bình xanh có thể dùng để giết người bất kỳ rồi chết. Nếu bị quản ngục giam sẽ không thể dùng chức năng.',
    [ROLE.CUPID]: 'Đêm đầu tiên sẽ ghép đôi hai người bất kỳ trở thành một cặp đôi. Cặp đôi được ghép sẽ sống chết cùng nhau, một người trong cặp đôi bị ghép hẹo sẽ kéo người kia hẹo cùng mình. Cupid sẽ không biết thân phận của hai người được ghép.\n\nNếu ghép cặp đôi Dân - Dân hay Sói - Sói: Cupid vẫn thuộc phe Dân. Kết quả chung cuộc vẫn sẽ theo phe Dân dù cặp đôi có sống hay không.\n\nNếu ghép cặp đôi Dân - Sói: Sẽ trở thành phe thứ 3. Kết quả chung cuộc khi cả hai người được ghép ( 1 dân - 1 sói ) vẫn còn sống và tất cả chết hết thì Cupid và hai người được ghép sẽ chiến thắng chung cuộc ( Dân và Sói đều thua).\n\nTrường hợp đặc biệt (Bán sói - Dân): Ban đầu vẫn được tính là phe Dân. Một khi Bán sói thành Sói thì lập tức sẽ được thông báo cho người được ghép để trở thành phe thứ ba.\n\nCặp đôi được ghép biết thân phận và chức năng của nhau.',
    [ROLE.HALF_WOLF]: 'Mặc định ban đầu là phe dân. Khi bị sói cắn sẽ không chết mà trở thành sói và theo sói. Nếu chưa hóa sói mà bị treo cổ, bị thảy bình, bị thợ săn bắn chết vẫn tính là phe dân. Về phần tiên tri: soi ra chức năng bán sói khi chưa hóa sói, nếu bán sói hóa sói sẽ soi thành sói. Khi trong giai đoạn bị quản ngục giam vẫn là bán sói thì bị sói cắn cũng sẽ không hóa sói.',
    [ROLE.JAILER]: 'Mỗi đêm sẽ chọn một người để giam, người bị giam không thể sử dụng chức năng của mình nhưng bù lại cũng có thể được bảo vệ hoàn toàn khỏi bị sói cắn. Có thể giam giữ một người nhiều đêm liên tiếp. Ưu tiên vai trò quản ngục hành động đầu tiên.',
    [ROLE.FOOL]: 'Thằng khờ sẽ giả vờ làm sói để dẫn dụ mọi người vote treo cổ. Một khi thằng khờ treo cổ sẽ chiến thắng ngay lập tức. Dân và Sói đều thua.',
};

// Long-form role guide grouped by faction, used for !roles embed (giữ nguyên
// văn bản gốc của bạn, không viết lại theo văn AI).
const ROLE_GUIDE = {
    village: {
        title: '🟢 Phe dân',
        intro: 'Dân làng, quản ngục, phù thủy, tiên tri vip pro, bảo vệ, thợ săn, tiên tri tập sự',
        roles: [
            ROLE.JAILER,
            ROLE.WITCH,
            ROLE.SEER,
            ROLE.GUARD,
            ROLE.HUNTER,
            ROLE.APPRENTICE_SEER,
        ],
    },
    third: {
        title: '🟠 Phe thứ 3',
        intro: 'Thằng khờ',
        roles: [ROLE.FOOL],
    },
    neutral: {
        title: '⚪ Neutral / Phe thứ 3 (chia cặp)',
        intro: 'Bán sói, Cupid và cặp đôi được ghép',
        roles: [ROLE.HALF_WOLF, ROLE.CUPID],
    },
    wolf: {
        title: '🔴 Phe sói',
        intro: 'Sói, sói tiên tri',
        roles: [ROLE.WEREWOLF, ROLE.WOLF_SEER],
    },
};

// ── States ──────────────────────────────────────────────────

const STATE = {
    LOBBY: 'lobby',
    NIGHT: 'night',
    DAY_TALK: 'day_talk',
    DAY_VOTE: 'day_vote',
    GAME_OVER: 'game_over',
};

// ── Role distribution table ─────────────────────────────────
//
// Bảng phân phối role theo số lượng người chơi (5-18+).
// Các slot còn lại sau khi gán role đặc biệt sẽ tự thành Dân (VILLAGER).
// Sói (pink): Sói, Sói tiên tri | Đặc biệt (yellow): Bán sói, Cupid, Thằng khờ

function getRoleDistribution(playerCount) {
    // 5:  Sói=1, BảoVệ=1 → Dân=3
    if (playerCount <= 5)  return { [ROLE.WEREWOLF]: 1, [ROLE.GUARD]: 1 };
    // 6:  Sói=1, BảoVệ=1 → Dân=4
    if (playerCount === 6) return { [ROLE.WEREWOLF]: 1, [ROLE.GUARD]: 1 };
    // 7:  Sói=2, BảoVệ=1, TiênTri=1 → Dân=3
    if (playerCount === 7) return { [ROLE.WEREWOLF]: 2, [ROLE.GUARD]: 1, [ROLE.SEER]: 1 };
    // 8:  Sói=2, BảoVệ=1, TiênTri=1, BánSói=1 → Dân=3
    if (playerCount === 8) return { [ROLE.WEREWOLF]: 2, [ROLE.GUARD]: 1, [ROLE.SEER]: 1, [ROLE.HALF_WOLF]: 1 };
    // 9:  Sói=2, BảoVệ=1, TiênTri=1, PhùThủy=1, ThợSăn=1, BánSói=1 → Dân=2
    if (playerCount === 9) return { [ROLE.WEREWOLF]: 2, [ROLE.GUARD]: 1, [ROLE.SEER]: 1, [ROLE.WITCH]: 1, [ROLE.HUNTER]: 1, [ROLE.HALF_WOLF]: 1 };
    // 10: Sói=2, BảoVệ=1, TiênTri=1, PhùThủy=1, ThợSăn=1, BánSói=1 → Dân=3
    if (playerCount === 10) return { [ROLE.WEREWOLF]: 2, [ROLE.GUARD]: 1, [ROLE.SEER]: 1, [ROLE.WITCH]: 1, [ROLE.HUNTER]: 1, [ROLE.HALF_WOLF]: 1 };
    // 11: Sói=2, SóiTT=1, BảoVệ=1, TiênTri=1, PhùThủy=1, ThợSăn=1, QuảnNgục=1, BánSói=1, Cupid=1 → Dân=1
    if (playerCount === 11) return { [ROLE.WEREWOLF]: 2, [ROLE.WOLF_SEER]: 1, [ROLE.GUARD]: 1, [ROLE.SEER]: 1, [ROLE.WITCH]: 1, [ROLE.HUNTER]: 1, [ROLE.JAILER]: 1, [ROLE.HALF_WOLF]: 1, [ROLE.CUPID]: 1 };
    // 12: Sói=2, SóiTT=1, BảoVệ=1, TiênTri=1, PhùThủy=1, ThợSăn=1, QuảnNgục=1, TTTậpSự=1, BánSói=1, Cupid=1 → Dân=1
    if (playerCount === 12) return { [ROLE.WEREWOLF]: 2, [ROLE.WOLF_SEER]: 1, [ROLE.GUARD]: 1, [ROLE.SEER]: 1, [ROLE.WITCH]: 1, [ROLE.HUNTER]: 1, [ROLE.JAILER]: 1, [ROLE.APPRENTICE_SEER]: 1, [ROLE.HALF_WOLF]: 1, [ROLE.CUPID]: 1 };
    // 13: Sói=2, SóiTT=1, BảoVệ=1, TiênTri=1, PhùThủy=1, ThợSăn=1, QuảnNgục=1, BánSói=1, Cupid=1 → Dân=3
    if (playerCount === 13) return { [ROLE.WEREWOLF]: 2, [ROLE.WOLF_SEER]: 1, [ROLE.GUARD]: 1, [ROLE.SEER]: 1, [ROLE.WITCH]: 1, [ROLE.HUNTER]: 1, [ROLE.JAILER]: 1, [ROLE.HALF_WOLF]: 1, [ROLE.CUPID]: 1 };
    // 14: Sói=3, SóiTT=1, BảoVệ=1, TiênTri=1, PhùThủy=1, ThợSăn=1, QuảnNgục=1, TTTậpSự=1, BánSói=1, Cupid=1 → Dân=2
    if (playerCount === 14) return { [ROLE.WEREWOLF]: 3, [ROLE.WOLF_SEER]: 1, [ROLE.GUARD]: 1, [ROLE.SEER]: 1, [ROLE.WITCH]: 1, [ROLE.HUNTER]: 1, [ROLE.JAILER]: 1, [ROLE.APPRENTICE_SEER]: 1, [ROLE.HALF_WOLF]: 1, [ROLE.CUPID]: 1 };
    // 15: Sói=3, SóiTT=1, BảoVệ=1, TiênTri=1, PhùThủy=1, ThợSăn=1, QuảnNgục=1, TTTậpSự=1, BánSói=1, Cupid=1, ThằngKhờ=1 → Dân=1
    if (playerCount === 15) return { [ROLE.WEREWOLF]: 3, [ROLE.WOLF_SEER]: 1, [ROLE.GUARD]: 1, [ROLE.SEER]: 1, [ROLE.WITCH]: 1, [ROLE.HUNTER]: 1, [ROLE.JAILER]: 1, [ROLE.APPRENTICE_SEER]: 1, [ROLE.HALF_WOLF]: 1, [ROLE.CUPID]: 1, [ROLE.FOOL]: 1 };
    // 16: Sói=3, SóiTT=1, BảoVệ=1, TiênTri=1, PhùThủy=1, ThợSăn=1, QuảnNgục=1, TTTậpSự=1, BánSói=2, Cupid=1, ThằngKhờ=1 → Dân=2
    if (playerCount === 16) return { [ROLE.WEREWOLF]: 3, [ROLE.WOLF_SEER]: 1, [ROLE.GUARD]: 1, [ROLE.SEER]: 1, [ROLE.WITCH]: 1, [ROLE.HUNTER]: 1, [ROLE.JAILER]: 1, [ROLE.APPRENTICE_SEER]: 1, [ROLE.HALF_WOLF]: 2, [ROLE.CUPID]: 1, [ROLE.FOOL]: 1 };
    // 17: Sói=3, SóiTT=1, BảoVệ=1, TiênTri=1, PhùThủy=1, ThợSăn=1, QuảnNgục=1, TTTậpSự=1, BánSói=2, Cupid=1, ThằngKhờ=1 → Dân=3
    if (playerCount === 17) return { [ROLE.WEREWOLF]: 3, [ROLE.WOLF_SEER]: 1, [ROLE.GUARD]: 1, [ROLE.SEER]: 1, [ROLE.WITCH]: 1, [ROLE.HUNTER]: 1, [ROLE.JAILER]: 1, [ROLE.APPRENTICE_SEER]: 1, [ROLE.HALF_WOLF]: 2, [ROLE.CUPID]: 1, [ROLE.FOOL]: 1 };
    // 18+: Sói=4, SóiTT=1, BảoVệ=1, TiênTri=1, PhùThủy=1, ThợSăn=1, QuảnNgục=1, TTTậpSự=1, BánSói=2, Cupid=1, ThằngKhờ=1 → Dân=3+
    return { [ROLE.WEREWOLF]: 4, [ROLE.WOLF_SEER]: 1, [ROLE.GUARD]: 1, [ROLE.SEER]: 1, [ROLE.WITCH]: 1, [ROLE.HUNTER]: 1, [ROLE.JAILER]: 1, [ROLE.APPRENTICE_SEER]: 1, [ROLE.HALF_WOLF]: 2, [ROLE.CUPID]: 1, [ROLE.FOOL]: 1 };
}

// ── Helpers ─────────────────────────────────────────────────

function isWolfTeam(p) {
    if (!p || !p.alive) return false;
    if (p.role === ROLE.WEREWOLF || p.role === ROLE.WOLF_SEER) return true;
    if (p.role === ROLE.HALF_WOLF && p.transformed) return true;
    return false;
}

function getDisplayRole(p) {
    if (p.role === ROLE.HALF_WOLF && p.transformed) return 'Sói';
    return ROLE_LABEL[p.role];
}

// Couples are "cross-faction" (3rd party) iff one member is wolf-team and the
// other is not. Recomputed dynamically each call (bán-sói transform flips it).
function isCrossFactionCouple(game) {
    if (!game.cupidCouple) return false;
    const [aId, bId] = game.cupidCouple;
    const a = game.players.get(aId);
    const b = game.players.get(bId);
    if (!a || !b || !a.alive || !b.alive) return false;
    const aWolf = isWolfTeam(a);
    const bWolf = isWolfTeam(b);
    return (aWolf && !bWolf) || (!aWolf && bWolf);
}

function getCupidPlayer(game) {
    if (!game.cupidCouple) return null;
    return game.getPlayerByRole(ROLE.CUPID);
}

function isPlayerInCouple(game, id) {
    return game.cupidCouple && (game.cupidCouple[0] === id || game.cupidCouple[1] === id);
}

// ── Player ──────────────────────────────────────────────────

class Player {
    constructor(discordId, displayName) {
        this.discordId = discordId;
        this.displayName = displayName;
        this.role = null;
        this.alive = true;
        this.transformed = false; // HALF_WOLF → Sói
    }

    get team() {
        if (this.role === ROLE.HALF_WOLF && this.transformed) return TEAM.WOLF;
        return ROLE_TEAM[this.role] || null;
    }

    get label() {
        return getDisplayRole(this);
    }
}

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 25;
const DEFAULT_DAY_MINUTES = 5;

class WerewolfGame {
    constructor(channelId, hostId) {
        this.channelId = channelId;
        this.hostId = hostId;
        this.state = STATE.LOBBY;

        this.dayMinutes = DEFAULT_DAY_MINUTES;

        // Night-action / vote timeouts (ms). Overridden by the command layer
        // from per-guild settings (/masoi setup); these are just fallbacks.
        this.actionTimeoutMs = 60_000;
        this.wolfVoteTimeoutMs = 90_000;
        this.cupidTimeoutMs = 180_000;

        // DM "✅ ... đã hoàn thành chức năng." gửi cho mọi người sau mỗi vai
        // trong đêm. Overridden bởi /masoi setup.
        this.nightProgressDm = true;

        this.players = new Map();
        this.round = 0;
        this.nightLog = []; // recap log, filled in by appendLog() each night

        // Night results (reset each night)
        this.wolfVotes = new Map();
        this.wolfTarget = null;
        this.seerTarget = null;
        this.guardTarget = null;
        this.guardPrevTarget = null;
        this.witchHealUsed = false;
        this.witchPoisonUsed = false;
        this.witchAction = null;

        // Cupid
        this.cupidCouple = null; // [id1, id2] — set on night 1

        // Jailer
        this.jailedTarget = null; // discordId jailed this night

        // Wolf seer: divine tracker + next-day vote lock
        this.wolfSeerDivinedLastNight = false;
        this.wolfSeerVoteLocked = false;

        // Couple 3rd-party transition notifier (once-only per couple)
        this.coupleNotifiedThirdParty = false;

        // Track user IDs granted access to the wolf channel this game
        // (populated when roles are assigned; cleared on endGame).
        this.wolfChannelAccessIds = new Set();

        // Day vote
        this.dayVotes = new Map();

        this.pendingDeaths = [];
        this.halfWolfTransformedThisNight = false;
        this.winner = null;
    }

    // ── Lobby ───────────────────────────────────────────

    addPlayer(discordId, displayName) {
        if (this.state !== STATE.LOBBY) return { ok: false, reason: 'not_lobby' };
        if (this.players.has(discordId)) return { ok: false, reason: 'already_joined' };
        if (this.players.size >= MAX_PLAYERS) return { ok: false, reason: 'full' };

        this.players.set(discordId, new Player(discordId, displayName));
        return { ok: true, count: this.players.size };
    }

    removePlayer(discordId) {
        if (this.state !== STATE.LOBBY) return { ok: false, reason: 'not_lobby' };
        if (!this.players.has(discordId)) return { ok: false, reason: 'not_in_game' };

        this.players.delete(discordId);
        return { ok: true, count: this.players.size };
    }

    canStart() {
        return this.players.size >= MIN_PLAYERS;
    }

    // ── Role assignment ─────────────────────────────────

    assignRoles() {
        const ids = shuffle([...this.players.keys()]);
        const dist = getRoleDistribution(ids.length);

        let idx = 0;
        for (const [role, count] of Object.entries(dist)) {
            for (let i = 0; i < count; i++) {
                this.players.get(ids[idx]).role = role;
                idx++;
            }
        }
        while (idx < ids.length) {
            this.players.get(ids[idx]).role = ROLE.VILLAGER;
            idx++;
        }
    }

    getPlayerByRole(role) {
        return [...this.players.values()].find(p => p.role === role && p.alive) || null;
    }

    // ── Night ───────────────────────────────────────────

    startNight() {
        this.state = STATE.NIGHT;
        this.round++;
        this.wolfVotes.clear();
        this.wolfTarget = null;
        this.seerTarget = null;
        this.guardTarget = null;
        this.witchAction = null;
        this.jailedTarget = null;
        this.pendingDeaths = [];
        this.halfWolfTransformedThisNight = false;

        // Shift wolf-seer divine → next-day vote lock
        this.wolfSeerVoteLocked = this.wolfSeerDivinedLastNight;
        this.wolfSeerDivinedLastNight = false;

        // Recap log entry for this night (filled in by appendLog as roles act).
        if (!this.nightLog) this.nightLog = [];
        this.nightLog.push({ round: this.round, entries: [] });
    }

    isJailed(discordId) {
        return this.jailedTarget === discordId;
    }

    getWolfIds() {
        return [...this.players.values()].filter(isWolfTeam).map(p => p.discordId);
    }

    getWolfTargets() {
        return [...this.players.values()].filter(p => p.alive && !isWolfTeam(p));
    }

    getAlivePlayersExcept(excludeId) {
        return [...this.players.values()]
            .filter(p => p.alive && p.discordId !== excludeId);
    }

    getAlivePlayers() {
        return [...this.players.values()].filter(p => p.alive);
    }

    // Wolves that should have access to the dedicated wolf channel
    // (WEREWOLF + WOLF_SEER only, regardless of bán-sói transform — bán-sói
    // is added separately when it transforms mid-game).
    getWolfChannelMembers() {
        return [...this.players.values()].filter(p =>
            (p.role === ROLE.WEREWOLF || p.role === ROLE.WOLF_SEER)
        );
    }

    // Add a user to the wolf-channel access tracker
    addWolfChannelAccess(discordId) {
        this.wolfChannelAccessIds.add(discordId);
    }

    // Clear all wolf-channel access (called on endGame cleanup)
    clearWolfChannelAccess() {
        this.wolfChannelAccessIds.clear();
    }

    isMainSeerDead() {
        const seer = [...this.players.values()].find(p => p.role === ROLE.SEER);
        return !seer || !seer.alive;
    }

    // ── Cupid ───────────────────────────────────────────

    submitCupidChoice(id1, id2) {
        this.cupidCouple = [id1, id2];
    }

    getCouplePartner(discordId) {
        if (!this.cupidCouple) return null;
        if (this.cupidCouple[0] === discordId) return this.cupidCouple[1];
        if (this.cupidCouple[1] === discordId) return this.cupidCouple[0];
        return null;
    }

    // ── Jailer ──────────────────────────────────────────

    submitJailerChoice(targetId) {
        this.jailedTarget = targetId;
    }

    // ── Wolf vote ───────────────────────────────────────

    submitWolfVote(wolfId, targetId) {
        if (!this.wolfVotes.has(wolfId)) {
            this.wolfVotes.set(wolfId, []);
        }
        this.wolfVotes.get(wolfId).push(targetId);
    }

    submitWolfVoteBatch(wolfId, targetIds) {
        this.wolfVotes.set(wolfId, targetIds);
    }

    resolveWolfVotes() {
        const allPicks = [];
        for (const picks of this.wolfVotes.values()) {
            allPicks.push(...picks);
        }

        // Per spec: if no wolf picked anyone (full timeout), skip the bite —
        // do not pick a random victim.
        if (allPicks.length === 0) {
            this.wolfTarget = null;
            return { resolved: true, target: null };
        }

        const tally = new Map();
        for (const t of allPicks) {
            tally.set(t, (tally.get(t) || 0) + 1);
        }

        const duplicates = [...tally.entries()].filter(([, count]) => count > 1);

        if (duplicates.length === 1) {
            this.wolfTarget = duplicates[0][0];
            return { resolved: true, target: this.wolfTarget };
        }

        if (duplicates.length > 1) {
            const tied = duplicates.map(([id]) => id);
            return { resolved: false, tied };
        }

        const allTargetIds = [...tally.keys()];
        return { resolved: false, tied: allTargetIds };
    }

    // ── Seer (vip pro) ──────────────────────────────────
    // Returns the EXACT role name (label), or "Sói" if a transformed bán sói.
    submitSeerCheck(targetId) {
        this.seerTarget = targetId;
        const target = this.players.get(targetId);
        if (!target) return null;
        return getDisplayRole(target);
    }

    // ── Wolf seer (soi vai trò, penalty: vote locked) ──
    submitWolfSeerCheck(targetId) {
        this.wolfSeerDivinedLastNight = true;
        const target = this.players.get(targetId);
        if (!target) return null;
        return getDisplayRole(target);
    }

    // ── Apprentice seer (only confirms certain village team; everyone else,
    //     including bán sói (transformed or not) and a cupid-couple already
    //     flipped to third party, comes back "không xác nhận được") ──
    submitApprenticeSeerCheck(targetId) {
        const target = this.players.get(targetId);
        if (!target) return null;
        if (target.role === ROLE.FOOL) return 'unknown';
        if (isWolfTeam(target)) return 'unknown';
        if (target.role === ROLE.HALF_WOLF) return 'unknown';
        if (target.role === ROLE.CUPID && isCrossFactionCouple(this)) return 'unknown';
        if (isPlayerInCouple(this, targetId) && isCrossFactionCouple(this)) return 'unknown';
        return 'village';
    }

    // ── Guard ───────────────────────────────────────────

    submitGuardProtect(targetId) {
        this.guardTarget = targetId;
    }

    canGuardProtect(targetId) {
        return targetId !== this.guardPrevTarget;
    }

    // ── Witch ───────────────────────────────────────────

    submitWitchAction(action) {
        this.witchAction = action;
        if (action.type === 'heal') this.witchHealUsed = true;
        if (action.type === 'poison') this.witchPoisonUsed = true;
    }

    // ── Centralised death (used by night, hunter, hang) ──
    // Marks a player dead and triggers couple chain (cause 'couple').
    applyDeath(id, cause, deathsList) {
        const p = this.players.get(id);
        if (!p || !p.alive) return deathsList;
        p.alive = false;
        deathsList.push({ discordId: id, cause });

        const partnerId = this.getCouplePartner(id);
        if (partnerId) {
            const partner = this.players.get(partnerId);
            if (partner && partner.alive) {
                this.applyDeath(partnerId, 'couple', deathsList);
            }
        }
        return deathsList;
    }

    // ── Resolve night ───────────────────────────────────
    // Order:
    //   1. Jailed target = protected from bite (no death, no transform)
    //   2. Untransformed bán sói + not jailed + not guard-protected → transform, no death
    //   3. Guard protect (blocks death)
    //   4. Witch heal (incl. self-heal when witch=bitten)
    //   5. Witch poison (cause 'poison')
    //   6. Couple chain via applyDeath
    resolveNight() {
        const deaths = [];
        let halfWolfBitten = false;
        let halfWolfTransformed = false;
        let coupleFlippedToThirdParty = false;

        // 1+2+3+4: Wolf bite
        if (this.wolfTarget) {
            const target = this.players.get(this.wolfTarget);
            let killed = true;
            const guarded = this.guardTarget === this.wolfTarget;

            // (1) Jailed target is fully protected from bite
            if (this.isJailed(this.wolfTarget)) {
                killed = false;
            }

            // (2) Untransformed bán sói + not jailed + not guard-protected + not
            //     witch-healed → transform, no death. Per spec, being guarded,
            //     jailed, OR witch-healed all block the transformation.
            const healed = this.witchAction?.type === 'heal';
            if (killed && target && target.role === ROLE.HALF_WOLF && !target.transformed && !guarded && !healed) {
                killed = false;
                target.transformed = true;
                halfWolfBitten = true;
                halfWolfTransformed = true;
                if (isPlayerInCouple(this, target.discordId)) {
                    if (isCrossFactionCouple(this) && !this.coupleNotifiedThirdParty) {
                        coupleFlippedToThirdParty = true;
                        this.coupleNotifiedThirdParty = true;
                    }
                }
            }

            // (3) Guard protection (blocks death for non-bán-sói targets, and
            //     blocks death when bán sói IS the guard target — handled via
            //     `guarded` flag above which short-circuits the transform path).
            if (killed && guarded) {
                killed = false;
            }

            // (4) Witch heal (incl. self-heal when witch = bitten target)
            if (killed && this.witchAction?.type === 'heal') {
                killed = false;
            }

            if (killed) {
                this.applyDeath(this.wolfTarget, 'wolf', deaths);
            }
        }

        // (5) Witch poison
        if (this.witchAction?.type === 'poison' && this.witchAction.target) {
            const poisonId = this.witchAction.target;
            const t = this.players.get(poisonId);
            if (t && t.alive) {
                this.applyDeath(poisonId, 'poison', deaths);
            }
        }

        this.guardPrevTarget = this.guardTarget;
        this.pendingDeaths = deaths;
        this.halfWolfTransformedThisNight = halfWolfTransformed;

        return { deaths, halfWolfBitten, halfWolfTransformed, coupleFlippedToThirdParty };
    }

    // ── Day ─────────────────────────────────────────────

    startDayTalk() {
        this.state = STATE.DAY_TALK;
    }

    startDayVote() {
        this.state = STATE.DAY_VOTE;
        this.dayVotes.clear();
    }

    submitDayVote(voterId, targetId) {
        this.dayVotes.set(voterId, targetId);
    }

    resolveDayVote() {
        const tally = new Map();

        for (const [voterId, targetId] of this.dayVotes) {
            if (!tally.has(targetId)) {
                tally.set(targetId, { count: 0, voters: [] });
            }
            const entry = tally.get(targetId);
            entry.count++;
            entry.voters.push(voterId);
        }

        let maxCount = 0;
        let topTargets = [];

        for (const [targetId, entry] of tally) {
            if (targetId === 'skip') continue;
            if (entry.count > maxCount) {
                maxCount = entry.count;
                topTargets = [targetId];
            } else if (entry.count === maxCount && maxCount > 0) {
                topTargets.push(targetId);
            }
        }

        let hanged = null;
        let foolWin = false;
        let foolId = null;

        if (topTargets.length === 1 && maxCount > 0) {
            const target = this.players.get(topTargets[0]);
            if (target && target.role === ROLE.FOOL) {
                // Fool hanged → instant sole winner
                this.state = STATE.GAME_OVER;
                this.winner = WINNER.FOOL;
                foolWin = true;
                foolId = target.discordId;
            } else {
                hanged = topTargets[0];
                if (target) target.alive = false;
            }
        }

        return { hanged, tally, foolWin, foolId };
    }

    // Day vote eligibility: alive players vote (foolRevealed mechanic removed).
    canVote(discordId) {
        const p = this.players.get(discordId);
        if (!p || !p.alive) return false;
        return true;
    }

    // ── Hunter ──────────────────────────────────────────
    // Per spec, triggers on death regardless of cause (bite, poison, hang,
    // shot, or couple chain) — caller passes whichever discordId just died.
    checkHunterDeath(discordId) {
        const p = this.players.get(discordId);
        if (p && p.role === ROLE.HUNTER && !p.alive) {
            return p;
        }
        return null;
    }

    executeHunterShot(targetId) {
        const target = this.players.get(targetId);
        if (target && target.alive) {
            target.alive = false;
            return target;
        }
        return null;
    }

    // ── Win check ───────────────────────────────────────
    // 4 winners: village | wolf | couple | fool.
    // 1. Cross-faction couple (3rd party) alive:
    //      - all other players (excl. couple + Cupid) dead → couple wins
    //      - otherwise → return null (blocks village & wolf)
    // 2. Wolf count (excl. couple defector members) === 0 → village
    // 3. Wolf count >= non-wolf → wolf
    checkWin() {
        const alive = this.getAlivePlayers();

        // 1) Cross-faction couple 3rd-party
        if (isCrossFactionCouple(this)) {
            const [aId, bId] = this.cupidCouple;
            const cupid = getCupidPlayer(this);
            const excludeIds = new Set([aId, bId]);
            if (cupid && cupid.alive) excludeIds.add(cupid.discordId);
            const othersAlive = alive.some(p => !excludeIds.has(p.discordId));
            if (!othersAlive) {
                this.state = STATE.GAME_OVER;
                this.winner = WINNER.COUPLE;
                return WINNER.COUPLE;
            }
            return null; // couple blocks main-faction wins
        }

        // 2+3) main factions
        const wolves = alive.filter(p => isWolfTeam(p)).length;
        const villagers = alive.filter(p => !isWolfTeam(p)).length;

        if (wolves === 0) {
            this.state = STATE.GAME_OVER;
            this.winner = WINNER.VILLAGE;
            return WINNER.VILLAGE;
        }
        if (wolves >= villagers) {
            this.state = STATE.GAME_OVER;
            this.winner = WINNER.WOLF;
            return WINNER.WOLF;
        }
        return null;
    }

    getWinners() {
        if (!this.winner) return [];

        if (this.winner === WINNER.FOOL) {
            return [...this.players.values()]
                .filter(p => p.role === ROLE.FOOL)
                .map(p => p.discordId);
        }

        if (this.winner === WINNER.COUPLE) {
            const ids = [];
            if (this.cupidCouple) ids.push(...this.cupidCouple);
            const cupid = getCupidPlayer(this);
            if (cupid) ids.push(cupid.discordId);
            return ids;
        }

        if (this.winner === WINNER.VILLAGE) {
            const cupidThirdParty = isCrossFactionCouple(this);
            return [...this.players.values()]
                .filter(p => {
                    if (!p.alive) return false;
                    if (p.role === ROLE.WEREWOLF || p.role === ROLE.WOLF_SEER) return false;
                    if (p.role === ROLE.HALF_WOLF && p.transformed) return false;
                    if (p.role === ROLE.CUPID && cupidThirdParty) return false;
                    return true;
                })
                .map(p => p.discordId);
        }

        if (this.winner === WINNER.WOLF) {
            return [...this.players.values()]
                .filter(p => p.alive && isWolfTeam(p))
                .map(p => p.discordId);
        }

        return [];
    }
}

// ── Utils ───────────────────────────────────────────────────

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

module.exports = {
    WerewolfGame,
    Player,
    ROLE,
    ROLE_LABEL,
    ROLE_DESC,
    ROLE_GUIDE,
    ROLE_TEAM,
    TEAM,
    WINNER,
    STATE,
    MIN_PLAYERS,
    MAX_PLAYERS,
    DEFAULT_DAY_MINUTES,
    getRoleDistribution,
    isWolfTeam,
    getDisplayRole,
    isCrossFactionCouple,
    isPlayerInCouple,
};
