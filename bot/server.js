/**
 * Salvo's Finest Discord Bot & Synchronization Server
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, SlashCommandBuilder } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");

const {
    syncTeamsWithDiscord,
    clearAllTeamRoles,
    deleteAllTrackedTeamRoles
} = require("./sync");

const isProduction =
    process.env.NODE_ENV === "production";

const PORT =
    Number(process.env.PORT || 3001);

const DISCORD_BOT_TOKEN =
    process.env.DISCORD_BOT_TOKEN;

const DISCORD_GUILD_ID =
    process.env.DISCORD_GUILD_ID;

const SUPABASE_URL =
    process.env.SUPABASE_URL ||
    "https://byrgpygkirkjdcnmicbm.supabase.co";

const SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY;

const BOT_API_SECRET =
    process.env.BOT_API_SECRET;

const RATE_LIMIT_WINDOW_MS =
    Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);

const RATE_LIMIT_MAX_REQUESTS =
    Number(process.env.RATE_LIMIT_MAX_REQUESTS || 10);

const MAX_TEAMS =
    Number(process.env.MAX_TEAMS || 100);

const MAX_PLAYERS_PER_TEAM =
    Number(process.env.MAX_PLAYERS_PER_TEAM || 10);

const MAX_TOTAL_PLAYERS =
    Number(process.env.MAX_TOTAL_PLAYERS || 500);

const CORS_ORIGIN =
    process.env.CORS_ORIGIN ||
    (isProduction ? "" : "http://localhost:3000,http://127.0.0.1:5500");

const allowedOrigins = CORS_ORIGIN
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

const configuration = {
    discordTokenConfigured: Boolean(DISCORD_BOT_TOKEN),
    discordGuildConfigured: Boolean(DISCORD_GUILD_ID),
    supabaseConfigured: Boolean(
        SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ),
    apiSecretConfigured: Boolean(BOT_API_SECRET),
    corsConfigured: allowedOrigins.length > 0
};

if (isProduction) {
    const missing = [];

    if (!DISCORD_BOT_TOKEN) {
        missing.push("DISCORD_BOT_TOKEN");
    }

    if (!DISCORD_GUILD_ID) {
        missing.push("DISCORD_GUILD_ID");
    }

    if (!SUPABASE_URL) {
        missing.push("SUPABASE_URL");
    }

    if (!SUPABASE_SERVICE_ROLE_KEY) {
        missing.push("SUPABASE_SERVICE_ROLE_KEY");
    }

    if (!BOT_API_SECRET) {
        missing.push("BOT_API_SECRET");
    }

    if (allowedOrigins.length === 0) {
        missing.push("CORS_ORIGIN");
    }

    if (missing.length > 0) {
        throw new Error(
            `Missing required production configuration: ${missing.join(", ")}`
        );
    }
} else {
    const warnings = [];

    if (!DISCORD_BOT_TOKEN) {
        warnings.push("DISCORD_BOT_TOKEN");
    }

    if (!DISCORD_GUILD_ID) {
        warnings.push("DISCORD_GUILD_ID");
    }

    if (!SUPABASE_SERVICE_ROLE_KEY) {
        warnings.push("SUPABASE_SERVICE_ROLE_KEY");
    }

    if (!BOT_API_SECRET) {
        warnings.push("BOT_API_SECRET");
    }

    if (warnings.length > 0) {
        console.warn(
            `[Config] Development configuration is incomplete: ${warnings.join(", ")}`
        );
    }
}

/* =========================================================
   SUPABASE
========================================================= */

const supabase =
    SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
        ? createClient(
            SUPABASE_URL,
            SUPABASE_SERVICE_ROLE_KEY,
            {
                auth: {
                    persistSession: false,
                    autoRefreshToken: false
                }
            }
        )
        : null;

/* =========================================================
   DISCORD
========================================================= */

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

/* =========================================================
   EXPRESS
========================================================= */

const app = express();

app.use(
    cors({
        origin(origin, callback) {
            // Allow non-browser requests such as curl and health monitors.
            if (!origin) {
                return callback(null, true);
            }

            if (!isProduction && allowedOrigins.includes("*")) {
                return callback(null, true);
            }

            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }

            return callback(
                new Error("Origin is not allowed by CORS.")
            );
        }
    })
);

app.use(
    express.json({
        limit: "100kb"
    })
);

/* =========================================================
   RATE LIMITING
========================================================= */

const rateLimitBuckets = new Map();

function getClientIp(req) {
    const forwardedFor =
        req.headers["x-forwarded-for"];

    if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
        return forwardedFor.split(",")[0].trim();
    }

    return req.socket.remoteAddress || "unknown";
}

function getRateLimitKey(req) {
    return (
        req.authIdentity ||
        getClientIp(req)
    );
}

function rateLimit(req, res, next) {
    const now = Date.now();
    const key = getRateLimitKey(req);

    let bucket =
        rateLimitBuckets.get(key);

    if (
        !bucket ||
        now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS
    ) {
        bucket = {
            startedAt: now,
            count: 0
        };

        rateLimitBuckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining =
        Math.max(
            0,
            RATE_LIMIT_MAX_REQUESTS - bucket.count
        );

    res.setHeader(
        "X-RateLimit-Limit",
        String(RATE_LIMIT_MAX_REQUESTS)
    );

    res.setHeader(
        "X-RateLimit-Remaining",
        String(remaining)
    );

    if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
        const retryAfterSeconds =
            Math.ceil(
                (
                    RATE_LIMIT_WINDOW_MS -
                    (now - bucket.startedAt)
                ) / 1000
            );

        res.setHeader(
            "Retry-After",
            String(retryAfterSeconds)
        );

        return res.status(429).json({
            error: "Too many requests.",
            message: "Please wait before trying again."
        });
    }

    next();
}

// Prevent this map from growing forever.
setInterval(() => {
    const now = Date.now();

    for (const [key, bucket] of rateLimitBuckets) {
        if (
            now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS
        ) {
            rateLimitBuckets.delete(key);
        }
    }
}, RATE_LIMIT_WINDOW_MS).unref();

/* =========================================================
   VALIDATION
========================================================= */

function validateTeams(teams) {
    if (!Array.isArray(teams)) {
        return "teams must be an array.";
    }

    if (teams.length === 0) {
        return null;
    }

    if (teams.length > MAX_TEAMS) {
        return `teams cannot contain more than ${MAX_TEAMS} teams.`;
    }

    let totalPlayers = 0;

    for (let teamIndex = 0; teamIndex < teams.length; teamIndex++) {
        const team = teams[teamIndex];

        if (!Array.isArray(team) || team.length === 0) {
            return `Team ${teamIndex + 1} must be a non-empty array.`;
        }

        if (team.length > MAX_PLAYERS_PER_TEAM) {
            return `Team ${teamIndex + 1} cannot contain more than ${MAX_PLAYERS_PER_TEAM} players.`;
        }

        totalPlayers += team.length;

        for (let playerIndex = 0; playerIndex < team.length; playerIndex++) {
            const player = team[playerIndex];

            if (!player || typeof player !== "object") {
                return `Team ${teamIndex + 1}, player ${playerIndex + 1} is invalid.`;
            }

            if (
                typeof player.apex_name !== "string" ||
                player.apex_name.trim().length === 0
            ) {
                return `Team ${teamIndex + 1}, player ${playerIndex + 1} requires apex_name.`;
            }

            if (player.apex_name.length > 100) {
                return `Team ${teamIndex + 1}, player ${playerIndex + 1} has an excessively long apex_name.`;
            }

            if (
                player.discord_name !== undefined &&
                player.discord_name !== null &&
                typeof player.discord_name !== "string"
            ) {
                return `Team ${teamIndex + 1}, player ${playerIndex + 1} has an invalid discord_name.`;
            }

            if (
                player.discord_id !== undefined &&
                player.discord_id !== null &&
                typeof player.discord_id !== "string" &&
                typeof player.discord_id !== "number"
            ) {
                return `Team ${teamIndex + 1}, player ${playerIndex + 1} has an invalid discord_id.`;
            }
        }
    }

    if (totalPlayers > MAX_TOTAL_PLAYERS) {
        return `The request cannot contain more than ${MAX_TOTAL_PLAYERS} players.`;
    }

    return null;
}

/* =========================================================
   AUTHENTICATION
========================================================= */

async function authenticateRequest(req, res, next) {
    const authHeader =
        req.headers.authorization;

    const apiSecretHeader =
        req.headers["x-api-secret"];

    // Trusted server-to-server authentication.
    if (
        BOT_API_SECRET &&
        (
            apiSecretHeader === BOT_API_SECRET ||
            authHeader === `Bearer ${BOT_API_SECRET}`
        )
    ) {
        req.authIdentity = "api-secret";
        req.authMethod = "api-secret";
        return next();
    }

    // Normal requests must use a Supabase JWT.
    if (
        !authHeader ||
        !authHeader.startsWith("Bearer ")
    ) {
        return res.status(401).json({
            error: "Unauthorized",
            message: "A Supabase Bearer token or API secret is required."
        });
    }

    if (!supabase) {
        return res.status(503).json({
            error: "Authentication unavailable",
            message: "Supabase authentication is not configured."
        });
    }

    const token =
        authHeader.slice(7).trim();

    try {
        const {
            data: {
                user
            },
            error: userError
        } = await supabase.auth.getUser(token);

        if (userError || !user) {
            return res.status(401).json({
                error: "Unauthorized",
                message: "Invalid or expired Supabase authentication token."
            });
        }

        const {
            data: adminUser,
            error: adminError
        } = await supabase
            .from("admin_users")
            .select("user_id")
            .eq("user_id", user.id)
            .maybeSingle();

        if (adminError) {
            console.error(
                "[Auth] Admin verification failed:",
                adminError.message
            );

            return res.status(503).json({
                error: "Authorization unavailable",
                message: "Unable to verify administrator access."
            });
        }

        if (!adminUser) {
            return res.status(403).json({
                error: "Forbidden",
                message: "Administrator access is required."
            });
        }

        req.user = user;
        req.authIdentity = `user:${user.id}`;
        req.authMethod = "supabase-admin";

        next();
    } catch (error) {
        console.error(
            "[Auth] Token verification failed:",
            error.message
        );

        return res.status(401).json({
            error: "Unauthorized",
            message: "Authentication verification failed."
        });
    }
}

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/api/health", (req, res) => {
    const discordReady =
        client.isReady();

    const guild =
        discordReady && DISCORD_GUILD_ID
            ? client.guilds.cache.get(DISCORD_GUILD_ID)
            : null;

    const readiness = {
        api: true,
        discord: discordReady,
        guild: Boolean(guild),
        supabase: Boolean(supabase),
        configuration: Object.values(configuration)
            .every(Boolean)
    };

    const ready =
        readiness.api &&
        readiness.discord &&
        readiness.guild &&
        readiness.supabase &&
        readiness.configuration;

    res.status(ready ? 200 : 503).json({
        status: ready ? "ready" : "starting",
        ready,
        configuration: {
            discordTokenConfigured:
            configuration.discordTokenConfigured,
            discordGuildConfigured:
            configuration.discordGuildConfigured,
            supabaseConfigured:
            configuration.supabaseConfigured,
            apiSecretConfigured:
            configuration.apiSecretConfigured,
            corsConfigured:
            configuration.corsConfigured
        },
        discord: {
            connected: discordReady,
            botUser: discordReady
                ? client.user.tag
                : null,
            guildFound: Boolean(guild),
            guildName: guild
                ? guild.name
                : null,
            memberCount: guild
                ? guild.memberCount
                : null
        },
        timestamp: new Date().toISOString()
    });
});

/* =========================================================
   SYNC TEAMS
========================================================= */

app.post(
    "/api/sync-teams",
    authenticateRequest,
    rateLimit,
    async (req, res) => {
        try {
            if (!client.isReady()) {
                return res.status(503).json({
                    success: false,
                    error: "Discord bot is not connected."
                });
            }

            const guild =
                client.guilds.cache.get(DISCORD_GUILD_ID);

            if (!guild) {
                return res.status(503).json({
                    success: false,
                    error: "Configured Discord server was not found."
                });
            }

            const suppliedTeams =
                req.body
                    ? req.body.teams
                    : undefined;

            if (suppliedTeams !== undefined) {
                const validationError =
                    validateTeams(suppliedTeams);

                if (validationError) {
                    return res.status(400).json({
                        success: false,
                        error: validationError
                    });
                }
            }

            let teams = null;

            // Always prefer the database as the source of truth.
            if (supabase) {
                const {
                    data: lobby,
                    error: lobbyError
                } = await supabase
                    .from("lobby_state")
                    .select("teams")
                    .eq("id", 1)
                    .maybeSingle();

                if (lobbyError) {
                    console.error(
                        "[API] Lobby state query failed:",
                        lobbyError.message
                    );

                    return res.status(500).json({
                        success: false,
                        error: "Unable to load authoritative lobby state."
                    });
                }

                if (lobby && lobby.teams !== null) {
                    teams = lobby.teams;
                }
            }

            // Development/compatibility fallback.
            if (teams === null) {
                teams =
                    suppliedTeams !== undefined
                        ? suppliedTeams
                        : [];
            }

            const teamsError =
                validateTeams(teams);

            if (teamsError) {
                return res.status(500).json({
                    success: false,
                    error: `Stored lobby teams are invalid: ${teamsError}`
                });
            }

            // Enrich team players using the database.
            if (supabase && Array.isArray(teams)) {
                const {
                    data: players,
                    error: playersError
                } = await supabase
                    .from("players")
                    .select("*");

                if (playersError) {
                    console.error(
                        "[API] Player enrichment query failed:",
                        playersError.message
                    );

                    return res.status(500).json({
                        success: false,
                        error: "Unable to load player identity data."
                    });
                }

                const playerMap =
                    new Map();

                for (const player of players || []) {
                    if (player.id) {
                        playerMap.set(
                            String(player.id),
                            player
                        );
                    }

                    if (player.apex_name) {
                        playerMap.set(
                            player.apex_name.toLowerCase(),
                            player
                        );
                    }
                }

                teams = teams.map(team =>
                    team.map(player => {
                        const dbPlayer =
                            (
                                player.id &&
                                playerMap.get(String(player.id))
                            ) ||
                            (
                                player.apex_name &&
                                playerMap.get(
                                    player.apex_name.toLowerCase()
                                )
                            );

                        return {
                            ...player,
                            discord_name:
                                player.discord_name ||
                                dbPlayer?.discord_name ||
                                null,
                            discord_id:
                                player.discord_id ||
                                dbPlayer?.discord_id ||
                                null
                        };
                    })
                );
            }

            console.log(
                `[API] Sync requested by ${req.authIdentity} for ${teams.length} teams.`
            );

            const result =
                await syncTeamsWithDiscord(guild, teams);

            return res.json(result);
        } catch (error) {
            console.error(
                "[API] Sync error:",
                error.message
            );

            return res.status(500).json({
                success: false,
                error: "Unexpected Discord synchronization error."
            });
        }
    }
);

/* =========================================================
   CLEAR TEAM ROLES
========================================================= */

app.post(
    "/api/clear-roles",
    authenticateRequest,
    rateLimit,
    async (req, res) => {
        try {
            if (!client.isReady()) {
                return res.status(503).json({
                    success: false,
                    error: "Discord bot is not connected."
                });
            }

            const guild =
                client.guilds.cache.get(DISCORD_GUILD_ID);

            if (!guild) {
                return res.status(503).json({
                    success: false,
                    error: "Configured Discord server was not found."
                });
            }

            console.log(
                `[API] Clearing team roles in guild "${guild.name}" for ${req.authIdentity}.`
            );

            const result =
                await clearAllTeamRoles(guild);

            return res.json(result);
        } catch (error) {
            console.error(
                "[API] Clear roles error:",
                error.message
            );

            return res.status(500).json({
                success: false,
                error: "Failed to clear team roles."
            });
        }
    }
);

/* =========================================================
   DELETE TRACKED TEAM ROLES
========================================================= */

app.post(
    "/api/delete-team-roles",
    authenticateRequest,
    rateLimit,
    async (req, res) => {
        try {
            if (!client.isReady()) {
                return res.status(503).json({
                    success: false,
                    error: "Discord bot is not connected."
                });
            }

            const guild = client.guilds.cache.get(DISCORD_GUILD_ID);

            if (!guild) {
                return res.status(503).json({
                    success: false,
                    error: "Configured Discord server was not found."
                });
            }

            console.log(
                `[API] Deleting tracked team roles in "${guild.name}" for ${req.authIdentity}.`
            );

            const result = await deleteAllTrackedTeamRoles(guild);
            return res.json(result);
        } catch (error) {
            console.error(
                "[API] Delete team roles error:",
                error.message
            );

            return res.status(500).json({
                success: false,
                error: "Failed to delete tracked team roles."
            });
        }
    }
);

/* =========================================================
   CHECK-IN API
========================================================= */

app.get(
    "/api/check-in/status",
    authenticateRequest,
    async (req, res) => {
        if (!supabase) {
            return res.status(503).json({ success: false, error: "Supabase is not configured." });
        }

        const { data, error } = await supabase
            .from("lobby_state")
            .select("check_in_enabled")
            .eq("id", 1)
            .maybeSingle();

        if (error || !data) {
            console.error("[Check-in] Status query failed:", error?.message);
            return res.status(500).json({ success: false, error: "Unable to load check-in status." });
        }

        return res.json({ success: true, enabled: data.check_in_enabled === true });
    }
);

app.post(
    "/api/check-in/toggle",
    authenticateRequest,
    rateLimit,
    async (req, res) => {
        if (!supabase) {
            return res.status(503).json({ success: false, error: "Supabase is not configured." });
        }

        if (typeof req.body?.enabled !== "boolean") {
            return res.status(400).json({ success: false, error: "enabled must be true or false." });
        }

        try {
            // Start each newly opened check-in window with a clean attendance list.
            if (req.body.enabled) {
                const { error: resetError } = await supabase
                    .from("players")
                    .update({ present: false });

                if (resetError) throw resetError;
            }

            const { data, error } = await supabase
                .from("lobby_state")
                .update({
                    check_in_enabled: req.body.enabled,
                    updated_at: new Date().toISOString()
                })
                .eq("id", 1)
                .select("check_in_enabled")
                .maybeSingle();

            if (error || !data) throw error || new Error("Lobby state row was not found.");

            console.log(`[Check-in] ${req.authIdentity} ${data.check_in_enabled ? "enabled" : "disabled"} Apex check-in.`);
            return res.json({ success: true, enabled: data.check_in_enabled === true });
        } catch (error) {
            console.error("[Check-in] Toggle failed:", error.message);
            return res.status(500).json({ success: false, error: "Unable to update check-in status." });
        }
    }
);

/* =========================================================
   DISCORD EVENTS
========================================================= */

client.once("ready", () => {
    console.log(
        `[Discord Bot] Logged in as ${client.user.tag}`
    );

    if (!DISCORD_GUILD_ID) {
        console.warn(
            "[Discord Bot] DISCORD_GUILD_ID is not configured."
        );

        return;
    }

    const guild = client.guilds.cache.get(DISCORD_GUILD_ID);

    if (guild) {
        client.application.commands.set([
            new SlashCommandBuilder()
                .setName("check-in")
                .setDescription("Mark yourself as present for the Apex custom game.")
                .toJSON()
        ], DISCORD_GUILD_ID).then(() => {
            console.log("[Discord Bot] Registered /check-in command.");
        }).catch(error => {
            console.error("[Discord Bot] Slash command registration failed:", error.message);
        });

        console.log(
            `[Discord Bot] Target Guild: "${guild.name}" (${guild.id}) - ${guild.memberCount} members`
        );
    } else {
        console.warn(
            "[Discord Bot] Target guild was not found."
        );
    }
});

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "check-in") return;

    try {
        if (!supabase) {
            return interaction.reply({ content: "Check-in is temporarily unavailable. Please contact an admin.", ephemeral: true });
        }

        const { data: lobby, error: lobbyError } = await supabase
            .from("lobby_state")
            .select("check_in_enabled")
            .eq("id", 1)
            .maybeSingle();

        if (lobbyError || !lobby) {
            console.error("[Check-in] Could not read check-in state:", lobbyError?.message);
            return interaction.reply({ content: "I couldn't verify whether check-in is open. Please try again later.", ephemeral: true });
        }

        if (lobby.check_in_enabled !== true) {
            return interaction.reply({ content: "Apex custom-game check-in is currently closed.", ephemeral: true });
        }

        // The players.discord_name field stores the Discord user ID.
        const { data: player, error: playerError } = await supabase
            .from("players")
            .select("id, apex_name, present")
            .eq("discord_name", interaction.user.id)
            .maybeSingle();

        if (playerError) {
            console.error("[Check-in] Player lookup failed:", playerError.message);
            return interaction.reply({ content: "I couldn't look up your registration. Please contact an admin.", ephemeral: true });
        }

        if (!player) {
            return interaction.reply({ content: "I couldn't find a registration linked to your Discord account. Make sure you registered with your Discord ID.", ephemeral: true });
        }

        if (player.present === true) {
            return interaction.reply({ content: `You're already checked in, ${player.apex_name}!`, ephemeral: true });
        }

        const { error: updateError } = await supabase
            .from("players")
            .update({ present: true })
            .eq("id", player.id);

        if (updateError) {
            console.error("[Check-in] Attendance update failed:", updateError.message);
            return interaction.reply({ content: "Your check-in couldn't be saved. Please try again.", ephemeral: true });
        }

        console.log(`[Check-in] ${interaction.user.tag} (${interaction.user.id}) checked in as ${player.apex_name}.`);
        return interaction.reply({ content: `You're checked in, ${player.apex_name}! Have a good game.`, ephemeral: true });
    } catch (error) {
        console.error("[Check-in] Command failed:", error.message);
        if (interaction.replied || interaction.deferred) {
            return interaction.followUp({ content: "Something went wrong while checking you in. Please contact an admin.", ephemeral: true });
        }
        return interaction.reply({ content: "Something went wrong while checking you in. Please contact an admin.", ephemeral: true });
    }
});

client.on("error", error => {
    console.error(
        "[Discord Bot] Client error:",
        error.message
    );
});

/* =========================================================
   STARTUP
========================================================= */

if (DISCORD_BOT_TOKEN) {
    client.login(DISCORD_BOT_TOKEN)
        .catch(error => {
            console.error(
                "[Discord Bot] Login failed:",
                error.message
            );
        });
} else {
    console.warn(
        "[Discord Bot] No token configured. Running API-only mode."
    );
}

app.listen(PORT, () => {
    console.log(
        `[Server] Discord Sync API running on port ${PORT}`
    );
});

module.exports = {
    app,
    client,
    validateTeams,
    rateLimit
};