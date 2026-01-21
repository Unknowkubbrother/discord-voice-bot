import {
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    GuildMember,
} from "discord.js";
import {
    joinVoiceChannel,
    entersState,
    VoiceConnectionStatus,
    getVoiceConnection,
} from "@discordjs/voice";

export const data = new SlashCommandBuilder()
    .setName("join")
    .setDescription("ให้บอทเข้าห้องพูดคุย (voice) ที่คุณอยู่");

export async function execute(interaction: ChatInputCommandInteraction) {
    // ✅ สำคัญ: กัน "แอปไม่ตอบสนอง" ด้วยการ defer ทันที
    await interaction.deferReply({ ephemeral: true });

    if (!interaction.guild) {
        return interaction.editReply("ใช้คำสั่งนี้ในเซิร์ฟเวอร์เท่านั้น");
    }

    const member = interaction.member as GuildMember;
    const channel = member?.voice?.channel;

    if (!channel) {
        return interaction.editReply("คุณต้องอยู่ในห้องพูดคุยก่อน แล้วค่อย /join");
    }

    // ถ้าเคยต่ออยู่แล้ว ให้เคลียร์ก่อน
    const existing = getVoiceConnection(interaction.guild.id);
    if (existing) existing.destroy();

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        return interaction.editReply(`เข้าห้องพูดคุย: **${channel.name}** แล้ว ✅`);
    } catch (e) {
        connection.destroy();
        return interaction.editReply(
            "เข้าห้องไม่สำเร็จ (timeout/permission) — เช็คสิทธิ์ Connect/Speak ของบอท"
        );
    }
}
