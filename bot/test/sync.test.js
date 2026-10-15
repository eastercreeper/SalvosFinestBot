const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
    normalizeIdentifier,
    getExistingTeamRoles,
    ensureTeamRoles,
    matchMember,
    syncTeamsWithDiscord,
    clearAllTeamRoles
} = require("../sync");

// Mock Discord.js Objects for testing
function createMockRole(id, name) {
    return { id, name };
}

function createMockMember({ id, username, tag, globalName, nickname, displayName, roles = [], bot = false }) {
    const roleCache = new Map(roles.map(r => [r.id, r]));
    const member = {
        id,
        user: { id, username, tag: tag || `${username}#0000`, globalName: globalName || username, bot },
        nickname: nickname || null,
        displayName: displayName || nickname || globalName || username,
        roles: {
            cache: roleCache,
            add: async (role, reason) => {
                roleCache.set(role.id, role);
            },
            remove: async (roleOrRoles, reason) => {
                const list = Array.isArray(roleOrRoles) ? roleOrRoles : (roleOrRoles.values ? Array.from(roleOrRoles.values()) : [roleOrRoles]);
                for (const r of list) {
                    const rId = typeof r === "string" ? r : r.id;
                    roleCache.delete(rId);
                }
            }
        }
    };
    return member;
}

function createMockGuild(roles = [], members = []) {
    const roleCache = new Map(roles.map(r => [r.id, r]));
    const memberMap = new Map(members.map(m => [m.id, m]));
    let roleIdCounter = 1000;

    return {
        roles: {
            cache: roleCache,
            fetch: async () => roleCache,
            create: async ({ name, mentionable, reason }) => {
                const id = `role_${++roleIdCounter}`;
                const newRole = createMockRole(id, name);
                roleCache.set(id, newRole);
                return newRole;
            }
        },
        members: {
            fetch: async () => memberMap
        }
    };
}

describe("Discord Role Synchronizer Unit Tests", () => {
    describe("normalizeIdentifier", () => {
        it("should strip @ and lowercase and trim", () => {
            assert.strictEqual(normalizeIdentifier("  @ApexPlayer#1234  "), "apexplayer#1234");
            assert.strictEqual(normalizeIdentifier(""), "");
            assert.strictEqual(normalizeIdentifier(null), "");
        });
    });

    describe("ensureTeamRoles (Role Creation & Reuse)", () => {
        it("should create missing roles and reuse existing ones", async () => {
            const role1 = createMockRole("role_1", "Team 1");
            const role2 = createMockRole("role_2", "Team 2");
            const guild = createMockGuild([role1, role2]);

            // Request 4 teams
            const { roleMap, created, reused } = await ensureTeamRoles(guild, 4);

            assert.strictEqual(roleMap.size, 4);
            assert.deepStrictEqual(reused, ["Team 1", "Team 2"]);
            assert.deepStrictEqual(created, ["Team 3", "Team 4"]);
            assert.strictEqual(roleMap.get(1).id, "role_1");
            assert.strictEqual(roleMap.get(2).id, "role_2");
            assert.strictEqual(roleMap.get(3).name, "Team 3");
            assert.strictEqual(roleMap.get(4).name, "Team 4");
        });
    });

    describe("matchMember", () => {
        const member1 = createMockMember({ id: "111", username: "octane_speed", tag: "octane_speed#0001" });
        const member2 = createMockMember({ id: "222", username: "wraith_main", globalName: "VoidWalker" });
        const member3 = createMockMember({ id: "333", username: "gibby_shield", nickname: "DomeKing" });
        const member4a = createMockMember({ id: "444", username: "dupe_name", globalName: "Dupe" });
        const member4b = createMockMember({ id: "555", username: "dupe_name", globalName: "Dupe" });
        const members = new Map([
            [member1.id, member1],
            [member2.id, member2],
            [member3.id, member3],
            [member4a.id, member4a],
            [member4b.id, member4b]
        ]);

        it("matches accurately by discord_id", () => {
            const result = matchMember(members, { discord_id: "111", apex_name: "Octane" });
            assert.strictEqual(result.member?.id, "111");
            assert.strictEqual(result.matchType, "id");
        });

        it("matches accurately by username with @ prefix", () => {
            const result = matchMember(members, { discord_name: "@octane_speed", apex_name: "Octane" });
            assert.strictEqual(result.member?.id, "111");
            assert.strictEqual(result.matchType, "username");
        });

        it("matches by global display name or nickname", () => {
            const result1 = matchMember(members, { discord_name: "VoidWalker", apex_name: "Wraith" });
            assert.strictEqual(result1.member?.id, "222");

            const result2 = matchMember(members, { discord_name: "DomeKing", apex_name: "Gibraltar" });
            assert.strictEqual(result2.member?.id, "333");
        });

        it("detects ambiguous matches and returns null member safely", () => {
            const result = matchMember(members, { discord_name: "dupe_name", apex_name: "Player" });
            assert.strictEqual(result.member, null);
            assert.strictEqual(result.matchType, "ambiguous");
        });

        it("handles unknown user gracefully", () => {
            const result = matchMember(members, { discord_name: "non_existent_player", apex_name: "Pathfinder" });
            assert.strictEqual(result.member, null);
            assert.strictEqual(result.matchType, "none");
        });
    });

    describe("syncTeamsWithDiscord (Full Workflow)", () => {
        it("assigns roles, swaps teams, removes obsolete team roles, and preserves non-team roles", async () => {
            const adminRole = createMockRole("role_admin", "Admin");
            const team1Role = createMockRole("role_t1", "Team 1");
            const team2Role = createMockRole("role_t2", "Team 2");

            // Player 1 has Admin role + Team 1 role
            const member1 = createMockMember({ id: "101", username: "player_one", roles: [adminRole, team1Role] });
            // Player 2 has no roles yet
            const member2 = createMockMember({ id: "102", username: "player_two", roles: [] });
            // Player 3 is not in Discord
            // Player 4 is in Team 2
            const member4 = createMockMember({ id: "104", username: "player_four", roles: [team2Role] });

            const guild = createMockGuild([adminRole, team1Role, team2Role], [member1, member2, member4]);

            // New generation: Move player_one to Team 2, player_two to Team 1, player_three (missing) to Team 1, player_four to Team 2 (unchanged)
            const teams = [
                // Team 1
                [
                    { apex_name: "Apex2", discord_name: "player_two" },
                    { apex_name: "Apex3", discord_name: "ghost_player" }
                ],
                // Team 2
                [
                    { apex_name: "Apex1", discord_name: "player_one" },
                    { apex_name: "Apex4", discord_name: "player_four" }
                ]
            ];

            const result = await syncTeamsWithDiscord(guild, teams);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.totalTeams, 2);
            assert.strictEqual(result.matchedCount, 3);
            assert.strictEqual(result.unmatchedCount, 1);
            assert.strictEqual(result.unmatchedPlayers[0].apex_name, "Apex3");

            // Check Member 1: Should have Admin + Team 2 (Team 1 removed!)
            assert.ok(member1.roles.cache.has("role_admin"), "Admin role should be preserved");
            assert.ok(member1.roles.cache.has("role_t2"), "Team 2 role should be added");
            assert.ok(!member1.roles.cache.has("role_t1"), "Team 1 role should be removed");

            // Check Member 2: Should have Team 1
            assert.ok(member2.roles.cache.has("role_t1"), "Team 1 role should be added");

            // Check Member 4: Should still have Team 2
            assert.ok(member4.roles.cache.has("role_t2"), "Team 2 role should remain");

            // Re-running idempotently:
            const reRunResult = await syncTeamsWithDiscord(guild, teams);
            assert.strictEqual(reRunResult.success, true);
            assert.strictEqual(reRunResult.matchedCount, 3);
            assert.ok(member1.roles.cache.has("role_admin"));
            assert.ok(member1.roles.cache.has("role_t2"));
            assert.ok(!member1.roles.cache.has("role_t1"));
        });
    });

    describe("clearAllTeamRoles", () => {
        it("clears all team roles while preserving community/admin roles", async () => {
            const adminRole = createMockRole("role_admin", "Admin");
            const team1Role = createMockRole("role_t1", "Team 1");
            const team2Role = createMockRole("role_t2", "Team 2");

            const member = createMockMember({ id: "201", username: "mod_user", roles: [adminRole, team1Role] });
            const guild = createMockGuild([adminRole, team1Role, team2Role], [member]);

            const result = await clearAllTeamRoles(guild);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.clearedCount, 1);
            assert.ok(member.roles.cache.has("role_admin"), "Admin role preserved");
            assert.ok(!member.roles.cache.has("role_t1"), "Team 1 role removed");
        });
    });
});
