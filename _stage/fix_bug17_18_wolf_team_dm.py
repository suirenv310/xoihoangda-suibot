#!/usr/bin/env python3
"""
Fix BUG #17 + #18: bán sói đã hóa không nhận DM "đồng đội sói"

BUG #17: werewolf_fixed.js line 1516
  OLD: if (isWolfTeam(p) && p.role !== ROLE.HALF_WOLF) {
  NEW: if (isWolfTeam(p)) {
  → Bán sói đã hóa cũng nhận DM list đồng đội

BUG #18: werewolf_fixed.js line 1190-1195
  OLD: DM transform chỉ nói "từ đêm sau bạn sẽ đi theo phe sói"
  NEW: Thêm list tên đồng đội sói hiện tại
"""
import sys
from pathlib import Path

WERE_FILE = Path("/root/sltd-bot/src/commands/game/werewolf.js")

def main():
    if not WERE_FILE.exists():
        print(f"ERROR: {WERE_FILE} not found")
        sys.exit(1)

    src = WERE_FILE.read_text(encoding="utf-8")
    original = src

    # === BUG #17: line 1516 ===
    old17 = "        if (isWolfTeam(p) && p.role !== ROLE.HALF_WOLF) {"
    new17 = "        if (isWolfTeam(p)) {"
    if old17 not in src:
        print("ERROR BUG #17: pattern not found")
        sys.exit(1)
    src = src.replace(old17, new17, 1)
    print("[OK] BUG #17: removed HALF_WOLF exclusion")

    # === BUG #18: line 1190-1195 ===
    # Replace the bare DM with a DM that lists current wolf teammates.
    old18 = """            await safeDM(client, transformed.discordId, {
                embeds: [new EmbedBuilder()
                    .setColor(0x8b0000)
                    .setTitle('🐺 Bạn đã hóa sói!')
                    .setDescription('Bạn bị sói cắn đêm nay. Vì là Bán sói, bạn không chết mà trở thành Sói thật — từ đêm sau bạn sẽ đi theo phe sói.')]
            });"""

    new18 = """            // BUG #18 FIX: list đồng đội sói hiện tại để bán sói biết ai là sói
            const currentWolfMates = [...game.players.values()]
                .filter(p => p.alive && isWolfTeam(p) && p.discordId !== transformed.discordId)
                .map(p => p.displayName)
                .join(', ');
            const wolfMatesNote = currentWolfMates
                ? `\\n\\nĐồng đội sói hiện tại: **${currentWolfMates}**`
                : '';
            await safeDM(client, transformed.discordId, {
                embeds: [new EmbedBuilder()
                    .setColor(0x8b0000)
                    .setTitle('🐺 Bạn đã hóa sói!')
                    .setDescription(
                        'Bạn bị sói cắn đêm nay. Vì là Bán sói, bạn không chết mà trở thành Sói thật — từ đêm sau bạn sẽ đi theo phe sói.'
                        + wolfMatesNote
                    )]
            });"""

    if old18 not in src:
        print("ERROR BUG #18: pattern not found")
        sys.exit(1)
    src = src.replace(old18, new18, 1)
    print("[OK] BUG #18: added wolfMates list to transform DM")

    if src == original:
        print("ERROR: no changes applied")
        sys.exit(1)

    # Backup
    backup = WERE_FILE.with_suffix(".js.bak.bug17_18")
    backup.write_text(original, encoding="utf-8")
    print(f"[OK] Backup: {backup}")

    WERE_FILE.write_text(src, encoding="utf-8")
    print(f"[OK] Wrote: {WERE_FILE}")

if __name__ == "__main__":
    main()
