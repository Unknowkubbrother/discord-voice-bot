import "dotenv/config";
import { REST, Routes } from "discord.js";

import { data as join } from "./commands/join";
import { data as leave } from "./commands/leave";

const token = process.env.DISCORD_TOKEN!;
const clientId = process.env.CLIENT_ID!;
const guildId = process.env.GUILD_ID!;

const rest = new REST({ version: "10" }).setToken(token);

await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: [join.toJSON(), leave.toJSON()],
});

console.log("Deployed slash commands to guild.");
