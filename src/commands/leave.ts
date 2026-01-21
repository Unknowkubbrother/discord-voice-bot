import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getVoiceConnection } from "@discordjs/voice";

export const data = new SlashCommandBuilder()
    .setName("leave")
    .setDescription("ให้บอทออกจากห้องพูดคุย (voice)");

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    if (!interaction.guild) {
        return interaction.editReply("ใช้คำสั่งนี้ในเซิร์ฟเวอร์เท่านั้น");
    }

    const connection = getVoiceConnection(interaction.guild.id);
    if (!connection) {
        return interaction.editReply("ตอนนี้บอทยังไม่ได้อยู่ในห้องพูดคุย");
    }

    connection.destroy();
    return interaction.editReply("ออกจากห้องพูดคุยแล้ว 👋");
}
