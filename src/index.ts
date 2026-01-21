// src/index.ts
process.on("warning", (w) => {
    if (w?.name === "TimeoutNegativeWarning") return;
    console.warn(w);
});


import "dotenv/config";
import {
    Client,
    GatewayIntentBits,
    GuildMember,
    type Message,
} from "discord.js";
import {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    entersState,
    VoiceConnectionStatus,
    AudioPlayerStatus,
    StreamType,
    type VoiceConnection,
    type AudioPlayer,
} from "@discordjs/voice";

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import ytSearch from "yt-search";

const PREFIX = "!";
const TOKEN = process.env.DISCORD_TOKEN!;
if (!TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");

type Track = {
    url: string;
    title: string;
    requestedBy: string;
};

type GuildMusicState = {
    connection: VoiceConnection;
    player: AudioPlayer;
    queue: Track[];
    playing?: Track;

    // running stuff (for cleanup on skip/stop)
    currentFfmpeg?: ChildProcessWithoutNullStreams;
    currentFile?: string;
};

const musicStates = new Map<string, GuildMusicState>();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once("clientReady", () => {
    console.log(`Logged in as ${client.user?.tag}`);
});

// ---------------- helpers ----------------
function isYouTubeUrl(s: string) {
    return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(s);
}

async function ensureConnected(member: GuildMember): Promise<VoiceConnection> {
    const guild = member.guild;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) throw new Error("คุณต้องอยู่ในห้องพูดคุยก่อน");

    const existing = getVoiceConnection(guild.id);
    if (existing) return existing;

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    return connection;
}

function getOrCreateState(guildId: string, connection: VoiceConnection): GuildMusicState {
    const existing = musicStates.get(guildId);
    if (existing) return existing;

    const player = createAudioPlayer();
    connection.subscribe(player);

    const state: GuildMusicState = { connection, player, queue: [] };

    player.on(AudioPlayerStatus.Idle, () => {
        state.playing = undefined;
        // cleanup current track resources
        cleanupNow(state).catch(console.error);
        playNext(guildId).catch(console.error);
    });

    player.on("error", (err) => {
        console.error("AudioPlayer error:", err);
        state.playing = undefined;
        cleanupNow(state).catch(console.error);
        playNext(guildId).catch(console.error);
    });

    musicStates.set(guildId, state);
    return state;
}

async function resolveTrack(query: string, requestedBy: string): Promise<Track> {
    if (isYouTubeUrl(query)) {
        // ดึง title ให้สวยขึ้น (optional)
        try {
            const res = await ytSearch(query);
            const v = res.videos?.[0];
            return { url: query, title: v?.title ?? query, requestedBy };
        } catch {
            return { url: query, title: query, requestedBy };
        }
    }

    const res = await ytSearch(query);
    const video = res.videos?.[0];
    if (!video?.url) throw new Error("หาเพลงไม่เจอ ลองคำอื่นดู");
    return {
        url: video.url,
        title: video.title ?? "Unknown title",
        requestedBy,
    };
}

// เลือก m4a ก่อน เพื่อตัดปัญหา opus/webm แปลกๆ
const YTDLP_FORMAT =
    "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio[ext=mp4]/bestaudio/best";

async function downloadToTempM4A(youtubeUrl: string, tag: string): Promise<string> {
    const tmpDir = path.join(os.tmpdir(), "discord-voice-bot");
    await fs.mkdir(tmpDir, { recursive: true });

    const outFile = path.join(tmpDir, `${tag}-${Date.now()}.m4a`);

    await new Promise<void>((resolve, reject) => {
        const p = spawn(
            "yt-dlp",
            [
                "--no-playlist",
                "-f",
                YTDLP_FORMAT,
                "-o",
                outFile,
                youtubeUrl,
            ],
            { stdio: ["ignore", "pipe", "pipe"] }
        );

        let err = "";
        p.stderr?.on("data", (d) => (err += d.toString()));
        p.on("error", reject);
        p.on("close", (code) => {
            if (code !== 0) return reject(new Error(`yt-dlp failed (${code}): ${err}`));
            resolve();
        });
    });

    return outFile;
}

function spawnFfmpegOggOpusFromFile(inputFile: string): ChildProcessWithoutNullStreams {
    const p = spawn(
        "ffmpeg",
        [
            "-hide_banner",
            "-loglevel",
            "warning",
            "-i",
            inputFile,
            "-vn",
            "-acodec",
            "libopus",
            "-b:a",
            "128k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-f",
            "ogg",
            "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
    );

    p.stderr?.on("data", (d) => console.error("[ffmpeg]", d.toString()));
    p.on("exit", (code) => {
        if (code !== 0) console.error(`[ffmpeg] exited with code ${code}`);
    });

    return p;
}

async function cleanupNow(state: GuildMusicState) {
    // kill ffmpeg (ถ้ามี)
    try {
        state.currentFfmpeg?.kill("SIGKILL");
    } catch { }
    state.currentFfmpeg = undefined;

    // delete temp file (ถ้ามี)
    if (state.currentFile) {
        try {
            await fs.unlink(state.currentFile);
        } catch { }
        state.currentFile = undefined;
    }
}

async function playNext(guildId: string) {
    const state = musicStates.get(guildId);
    if (!state) return;

    const next = state.queue.shift();
    if (!next) return;

    state.playing = next;

    // cleanup ของเดิมเผื่อค้าง
    await cleanupNow(state);

    try {
        // ✅ download -> ffmpeg -> resource (นิ่งสุด)
        const file = await downloadToTempM4A(next.url, guildId);
        state.currentFile = file;

        const ffmpeg = spawnFfmpegOggOpusFromFile(file);
        state.currentFfmpeg = ffmpeg;

        const stream = ffmpeg.stdout as unknown as Readable;
        const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });

        state.player.play(resource);
    } catch (e) {
        console.error("playNext failed:", e);
        state.playing = undefined;
        await cleanupNow(state);
        return playNext(guildId); // ข้ามไปเพลงถัดไปถ้ามี
    }
}

// ---------------- commands ----------------
client.on("messageCreate", async (message: Message) => {
    try {
        if (message.author.bot) return;
        if (!message.guild) return;
        if (!message.content.startsWith(PREFIX)) return;

        const [rawCmd, ...rest] = message.content.slice(PREFIX.length).trim().split(/\s+/);
        const cmd = (rawCmd ?? "").toLowerCase();
        const args = rest.join(" ").trim();

        if (cmd === "help") {
            return message.reply(
                [
                    "คำสั่ง:",
                    "- `!join` ให้บอทเข้าห้องพูดคุย",
                    "- `!play <ลิงก์ youtube หรือคำค้น>` เล่นเพลงจาก YouTube",
                    "- `!skip` ข้ามเพลง",
                    "- `!stop` หยุดและล้างคิว",
                    "- `!queue` ดูคิว",
                    "- `!leave` ให้ออกจากห้อง",
                ].join("\n")
            );
        }

        if (cmd === "join") {
            const member = message.member as GuildMember;
            await ensureConnected(member);
            return message.reply("เข้าห้องพูดคุยแล้ว ✅");
        }

        if (cmd === "leave") {
            const conn = getVoiceConnection(message.guild.id);
            if (!conn) return message.reply("บอทยังไม่ได้อยู่ในห้องพูดคุย");

            const state = musicStates.get(message.guild.id);
            if (state) {
                state.queue = [];
                state.player.stop(true);
                await cleanupNow(state);
                musicStates.delete(message.guild.id);
            }

            conn.destroy();
            return message.reply("ออกจากห้องพูดคุยแล้ว 👋");
        }

        if (cmd === "play") {
            if (!args) return message.reply("ใช้แบบนี้: `!play <ลิงก์ youtube หรือคำค้น>`");

            const member = message.member as GuildMember;
            const connection = await ensureConnected(member);
            const state = getOrCreateState(message.guild.id, connection);

            const track = await resolveTrack(args, message.author.username);
            state.queue.push(track);

            if (state.player.state.status !== AudioPlayerStatus.Playing && !state.playing) {
                await playNext(message.guild.id);
                return message.reply(`กำลังเตรียมเล่น: **${track.title}** 🎵`);
            }

            return message.reply(`เพิ่มเข้าคิวแล้ว: **${track.title}**`);
        }

        if (cmd === "skip") {
            const state = musicStates.get(message.guild.id);
            if (!state) return message.reply("ยังไม่มีเพลงกำลังเล่น");
            state.player.stop(true); // จะ trigger Idle -> cleanup -> playNext
            return message.reply("ข้ามเพลงแล้ว ⏭️");
        }

        if (cmd === "stop") {
            const state = musicStates.get(message.guild.id);
            if (!state) return message.reply("ยังไม่มีเพลงกำลังเล่น");
            state.queue = [];
            state.playing = undefined;
            state.player.stop(true);
            await cleanupNow(state);
            return message.reply("หยุดเพลงและล้างคิวแล้ว 🛑");
        }

        if (cmd === "queue") {
            const state = musicStates.get(message.guild.id);
            if (!state) return message.reply("ยังไม่มีคิว");

            const now = state.playing ? `กำลังเล่น: **${state.playing.title}**\n` : "";
            const list =
                state.queue.length === 0
                    ? "คิวว่าง"
                    : state.queue
                        .slice(0, 10)
                        .map((t, i) => `${i + 1}. ${t.title} (req: ${t.requestedBy})`)
                        .join("\n");

            return message.reply(now + list);
        }
    } catch (err: any) {
        console.error(err);
        try {
            const msg = String(err?.message ?? "");
            if (msg.includes("spawn yt-dlp")) {
                await message.reply("หา `yt-dlp` ไม่เจอ — ติดตั้งด้วย `brew install yt-dlp`");
            } else if (msg.includes("spawn ffmpeg")) {
                await message.reply("หา `ffmpeg` ไม่เจอ — ติดตั้งด้วย `brew install ffmpeg`");
            } else {
                await message.reply(`เกิดข้อผิดพลาด: ${err?.message ?? "unknown"}`);
            }
        } catch { }
    }
});

await client.login(TOKEN);
