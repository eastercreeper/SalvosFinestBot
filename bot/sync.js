/**
 * Salvo's Finest Apex Custom Lobbies - Discord Team Role Synchronizer
 * 
 * Handles:
 * 1. Automatic dynamic team role creation and reuse (Team 1, Team 2, ...)
 * 2. Robust member matching by Discord ID or Username/Tag/Display Name
 * 3. Idempotent role assignment and cleanup of outdated team roles
 * 4. Safe error handling for missing/unmatched players
 */

/**
 * Normalizes username strings for comparison
 * @param {string} str
 * @returns {string}
 */
function normalizeIdentifier(str) {
    if (!str) return "";
    return str.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Finds all custom lobby team roles currently existing in the guild (e.g. "Team 1", "Team 2", etc.)
 * @param {import('discord.js').Guild} guild
 * @returns {Map<string, import('discord.js').Role>} Map of normalized role name -> Role
 */
const fs = require("node:fs");
const path = require("node:path");

const ROLE_REGISTRY_PATH = path.join(
    __dirname,
    "team-role-registry.json"
);

function getExistingTeamRoles(guild) {
    const teamRoleMap = new Map();
    const teamRolePattern = /^Team\s+(\d+)$/i;

    for (const [id, role] of guild.roles.cache) {
        const match = role.name.match(teamRolePattern);
        if (match) {
            const teamNumber = parseInt(match[1], 10);
            teamRoleMap.set(`team ${teamNumber}`, role);
        }
    }

    return teamRoleMap;
}

function readRoleRegistry() {
    try {
        return JSON.parse(
            fs.readFileSync(ROLE_REGISTRY_PATH, "utf8")
        );
    } catch (error) {
        if (error.code === "ENOENT") {
            return {};
        }

        throw error;
    }
}

function writeRoleRegistry(registry) {
    fs.writeFileSync(
        ROLE_REGISTRY_PATH,
        JSON.stringify(registry, null, 2),
        { mode: 0o600 }
    );
}

function getTrackedTeamRoleIds(guild, seedExisting = false) {
    const registry = readRoleRegistry();

    if (!Array.isArray(registry[guild.id])) {
        // One-time migration: you confirmed existing team roles
        // were created by this bot.
        registry[guild.id] = seedExisting
            ? [...getExistingTeamRoles(guild).values()]
                .map(role => role.id)
            : [];

        writeRoleRegistry(registry);
    }

    return new Set(
        registry[guild.id].filter(id =>
            guild.roles.cache.has(id)
        )
    );
}

function registerTeamRole(guild, role) {
    const registry = readRoleRegistry();

    if (!Array.isArray(registry[guild.id])) {
        registry[guild.id] = [];
    }

    if (!registry[guild.id].includes(role.id)) {
        registry[guild.id].push(role.id);
        writeRoleRegistry(registry);
    }
}

function unregisterTeamRole(guild, roleId) {
    const registry = readRoleRegistry();

    if (!Array.isArray(registry[guild.id])) {
        return;
    }

    registry[guild.id] =
        registry[guild.id].filter(id => id !== roleId);

    writeRoleRegistry(registry);
}

function getTrackedTeamRoles(guild) {
    const trackedIds = getTrackedTeamRoleIds(guild, true);
    const roles = new Map();

    for (const roleId of trackedIds) {
        const role = guild.roles.cache.get(roleId);
        const match = role?.name.match(/^Team\s+(\d+)$/i);

        if (role && match) {
            roles.set(`team ${parseInt(match[1], 10)}`, role);
        }
    }

    return roles;
}

/**
 * Ensures team roles exist for all generated teams up to totalTeams.
 * Reuses existing roles; creates missing roles sequentially.
 * 
 * @param {import('discord.js').Guild} guild
 * @param {number} totalTeams
 * @returns {Promise<{ roleMap: Map<number, import('discord.js').Role>, created: string[], reused: string[] }>}
 */
async function ensureTeamRoles(guild, totalTeams) {
    // Refresh roles cache
    await guild.roles.fetch();

    const existingTeamRoles = getTrackedTeamRoles(guild);
    const roleMap = new Map();
    const created = [];
    const reused = [];

    for (let i = 1; i <= totalTeams; i++) {
        const key = `team ${i}`;
        const canonicalName = `Team ${i}`;

        if (existingTeamRoles.has(key)) {
            const role = existingTeamRoles.get(key);
            roleMap.set(i, role);
            reused.push(role.name);
        } else {
            console.log(`[Discord Bot] Creating missing role: "${canonicalName}"`);
            const newRole = await guild.roles.create({
                name: canonicalName,
                mentionable: true,
                reason: `Salvo's Finest Custom Lobby team role auto-creation (Team ${i})`
            });
            registerTeamRole(guild, newRole);

            roleMap.set(i, newRole);
            created.push(newRole.name);
        }
    }

    return { roleMap, created, reused };
}

/**
 * Matches a registered player to a Discord guild member
 * 
 * @param {import('discord.js').Collection<string, import('discord.js').GuildMember>} members
 * @param {{ id?: string|number, apex_name?: string, discord_name?: string, discord_id?: string }} player
 * @returns {{ member: import('discord.js').GuildMember | null, matchType: string, ambiguityReason?: string }}
 */
function matchMember(members, player) {
    const rawDiscordId = player.discord_id ? String(player.discord_id).trim() : null;
    const rawDiscordName = player.discord_name ? String(player.discord_name).trim() : null;

    // 1. Direct Snowflake ID matching (highest accuracy)
    if (rawDiscordId && members.has(rawDiscordId)) {
        return {
            member: members.get(rawDiscordId),
            matchType: "id"
        };
    }

    if (!rawDiscordName) {
        return {
            member: null,
            matchType: "none",
            ambiguityReason: "No Discord identifier provided"
        };
    }

    const normalizedTarget = normalizeIdentifier(rawDiscordName);

    // 2. Exact match against username (new Discord username format, e.g. "salvo_player")
    const usernameMatches = [];
    // 3. Exact match against user tag (legacy Discord format, e.g. "salvo#1234")
    const tagMatches = [];
    // 4. Exact match against global display name or server nickname
    const displayNameMatches = [];

    for (const [, member] of members) {
        if (member.user.bot) continue;

        const username = normalizeIdentifier(member.user.username);
        const tag = normalizeIdentifier(member.user.tag);
        const globalName = normalizeIdentifier(member.user.globalName);
        const nickname = normalizeIdentifier(member.nickname);
        const displayName = normalizeIdentifier(member.displayName);

        if (username === normalizedTarget) {
            usernameMatches.push(member);
        } else if (tag === normalizedTarget) {
            tagMatches.push(member);
        } else if (globalName === normalizedTarget || nickname === normalizedTarget || displayName === normalizedTarget) {
            displayNameMatches.push(member);
        }
    }

    if (usernameMatches.length === 1) {
        return { member: usernameMatches[0], matchType: "username" };
    }
    if (usernameMatches.length > 1) {
        return {
            member: null,
            matchType: "ambiguous",
            ambiguityReason: `Multiple members matched username "${rawDiscordName}"`
        };
    }

    if (tagMatches.length === 1) {
        return { member: tagMatches[0], matchType: "tag" };
    }
    if (tagMatches.length > 1) {
        return {
            member: null,
            matchType: "ambiguous",
            ambiguityReason: `Multiple members matched tag "${rawDiscordName}"`
        };
    }

    if (displayNameMatches.length === 1) {
        return { member: displayNameMatches[0], matchType: "displayName" };
    }
    if (displayNameMatches.length > 1) {
        return {
            member: null,
            matchType: "ambiguous",
            ambiguityReason: `Multiple members matched server nickname/display name "${rawDiscordName}"`
        };
    }

    return {
        member: null,
        matchType: "none",
        ambiguityReason: `No Discord member found matching "${rawDiscordName}"`
    };
}

/**
 * Synchronizes generated teams with the Discord guild:
 * 1. Ensures Team 1..N roles exist
 * 2. Fetches guild members
 * 3. Assigns correct Team N role and removes outdated Team X roles
 * 
 * @param {import('discord.js').Guild} guild
 * @param {Array<Array<{ id?: string|number, apex_name: string, discord_name?: string, discord_id?: string }>>} teams
 * @returns {Promise<{
 *   success: boolean,
 *   totalTeams: number,
 *   rolesCreated: string[],
 *   rolesReused: string[],
 *   matchedCount: number,
 *   unmatchedCount: number,
 *   unmatchedPlayers: Array<{ apex_name: string, discord_name?: string, reason: string }>,
 *   assignments: Array<{ apex_name: string, discordUser: string, team: number, action: string }>,
 *   errors: string[]
 * }>}
 */
async function syncTeamsWithDiscord(guild, teams) {
    if (!guild) {
        throw new Error("Discord guild is not available or bot is not connected.");
    }

    if (!Array.isArray(teams) || teams.length === 0) {
        return {
            success: true,
            totalTeams: 0,
            rolesCreated: [],
            rolesReused: [],
            matchedCount: 0,
            unmatchedCount: 0,
            unmatchedPlayers: [],
            assignments: [],
            errors: []
        };
    }

    const totalTeams = teams.length;

    // Step 1: Ensure all required team roles exist
    const { roleMap, created, reused } = await ensureTeamRoles(guild, totalTeams);

    // Collect all team role IDs in the guild (both current and higher numbers if they exist)
    const allTeamRoleIds = getTrackedTeamRoleIds(guild, true);
    for (const role of roleMap.values()) {
        allTeamRoleIds.add(role.id);
    }

    // Step 2: Fetch all guild members
    const members = await guild.members.fetch();

    const assignments = [];
    const unmatchedPlayers = [];
    const errors = [];
    let matchedCount = 0;

    // Step 3: Iterate through each team and assign roles
    for (let teamIndex = 0; teamIndex < teams.length; teamIndex++) {
        const teamNumber = teamIndex + 1;
        const targetRole = roleMap.get(teamNumber);
        const teamPlayers = teams[teamIndex] || [];

        for (const player of teamPlayers) {
            try {
                const matchResult = matchMember(members, player);

                if (!matchResult.member) {
                    unmatchedPlayers.push({
                        apex_name: player.apex_name || "Unknown",
                        discord_name: player.discord_name || "N/A",
                        reason: matchResult.ambiguityReason || "Member not found in Discord server"
                    });
                    continue;
                }

                const member = matchResult.member;
                matchedCount++;

                // Determine existing team roles to remove
                const rolesToRemove = [];
                for (const roleId of member.roles.cache.keys()) {
                    if (allTeamRoleIds.has(roleId) && roleId !== targetRole.id) {
                        rolesToRemove.push(roleId);
                    }
                }

                const alreadyHasTargetRole = member.roles.cache.has(targetRole.id);

                let action = "unchanged";

                // Remove outdated team roles
                if (rolesToRemove.length > 0) {
                    await member.roles.remove(rolesToRemove, `Updating team role to Team ${teamNumber}`);
                    action = alreadyHasTargetRole ? "cleaned_old_roles" : "swapped_team";
                }

                // Add target team role if missing
                if (!alreadyHasTargetRole) {
                    await member.roles.add(targetRole, `Assigned to Team ${teamNumber}`);
                    action = rolesToRemove.length > 0 ? "swapped_team" : "assigned";
                }

                assignments.push({
                    apex_name: player.apex_name,
                    discordUser: member.user.tag || member.user.username,
                    discordId: member.id,
                    team: teamNumber,
                    action
                });

                console.log(`[Discord Bot] ${player.apex_name} (${member.user.tag}) -> Team ${teamNumber} [${action}]`);
            } catch (playerError) {
                console.error(`[Discord Bot] Error assigning role to player ${player.apex_name}:`, playerError);
                errors.push(`Failed to assign role for ${player.apex_name}: ${playerError.message}`);
                unmatchedPlayers.push({
                    apex_name: player.apex_name,
                    discord_name: player.discord_name,
                    reason: `Role assignment error: ${playerError.message}`
                });
            }
        }
    }

    return {
        success: errors.length === 0,
        totalTeams,
        rolesCreated: created,
        rolesReused: reused,
        matchedCount,
        unmatchedCount: unmatchedPlayers.length,
        unmatchedPlayers,
        assignments,
        errors
    };
}

/**
 * Clears team roles from all server members (e.g. when the admin clears the lobby)
 * 
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<{ success: boolean, clearedCount: number, errors: string[] }>}
 */
async function clearAllTeamRoles(guild) {
    if (!guild) {
        throw new Error("Discord guild is not available.");
    }

    await guild.roles.fetch();
    const teamRoleIds = getTrackedTeamRoleIds(guild, true);

    if (teamRoleIds.size === 0) {
        return { success: true, clearedCount: 0, errors: [] };
    }

    const members = await guild.members.fetch();
    let clearedCount = 0;
    const errors = [];

    for (const [, member] of members) {
        const rolesToRemove = [];
        for (const roleId of member.roles.cache.keys()) {
            if (teamRoleIds.has(roleId)) {
                rolesToRemove.push(roleId);
            }
        }
        if (rolesToRemove.length > 0) {
            try {
                await member.roles.remove(rolesToRemove, "Salvo's Finest Custom Lobby cleared");
                clearedCount++;
            } catch (err) {
                console.error(`[Discord Bot] Error clearing roles for ${member.user.tag}:`, err);
                errors.push(`Failed to clear roles for ${member.user.tag}: ${err.message}`);
            }
        }
    }

    return {
        success: errors.length === 0,
        clearedCount,
        errors
    };
}

/**
 * Deletes tracked bot-managed team roles after removing them
 * from guild members.
 */
async function deleteAllTrackedTeamRoles(guild) {
    if (!guild) {
        throw new Error("Discord guild is not available.");
    }

    await guild.roles.fetch();

    // The registry contains IDs verified as bot-managed.
    const trackedRoleIds = getTrackedTeamRoleIds(guild, true);
    const members = await guild.members.fetch();

    let deletedCount = 0;
    const errors = [];

    for (const roleId of trackedRoleIds) {
        const role = guild.roles.cache.get(roleId);

        // Ignore IDs whose roles no longer exist.
        if (!role) {
            unregisterTeamRole(guild, roleId);
            continue;
        }

        try {
            // Remove the role from every member who has it.
            for (const [, member] of members) {
                if (member.roles.cache.has(roleId)) {
                    await member.roles.remove(
                        roleId,
                        "Salvo's Finest admin deleted tracked team role"
                    );
                }
            }

            await role.delete(
                "Salvo's Finest admin deleted tracked team role"
            );

            unregisterTeamRole(guild, roleId);
            deletedCount++;
        } catch (error) {
            console.error(
                `[Discord Bot] Failed to delete tracked role ${role.name} (${roleId}):`,
                error.message
            );

            errors.push(`Failed to delete ${role.name}: ${error.message}`);
        }
    }

    return {
        success: errors.length === 0,
        deletedCount,
        errors
    };
}

module.exports = {
    normalizeIdentifier,
    getExistingTeamRoles,
    ensureTeamRoles,
    matchMember,
    syncTeamsWithDiscord,
    clearAllTeamRoles,
    deleteAllTrackedTeamRoles
};