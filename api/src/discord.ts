import { GUILD_ID } from "../../common/config";
import { prisma } from "../../common/db";
import { Role, roles } from "../../common/discord";

const fetchRoles = (discordId: string, retries = 3): Promise<any> =>
  fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}`, {
    headers: { Authorization: "Bot " + process.env.DISCORD_BOT_TOKEN },
  }).then(async (response) => {
    if (response.ok) return response.json();

    const text = await response.text();
    if (text.includes("Unknown Member")) return { roles: [] };
    if (text.includes("Not Found")) return { roles: [] };
    if (text.includes("You are being rate limited")) {
      console.log("Rate limited, waiting 1s");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (retries === 0) throw new Error("Rate limited");

      return fetchRoles(discordId, retries - 1);
    }
    const errMsg = (text || "Unknown error") + " " + discordId;
    throw new Error(errMsg);
  });

// MUST ADD THE BOT TO THE DISCORD SERVER TO MAKE IT WORK
export const getRoles = async (discordId: string): Promise<Role[]> => {
  const response = await fetchRoles(discordId);

  const roleIds: string[] = response.roles;
  return roles.filter((role) => roleIds.includes(role.id));
};

export const getUser = async (discordId: string) => {
  const response = await fetch(
    `https://discord.com/api/v10/users/${discordId}`,
    { headers: { Authorization: "Bot " + process.env.DISCORD_BOT_TOKEN } }
  ).then(async (response) => {
    if (response.ok) return response.json();
    else {
      const text = await response.text();
      throw new Error(text || "Unknown error");
    }
  });
  return response;
};

export const getId = async (address: string) => {
  return prisma.user
    .findUnique({ where: { address } })
    .then((user) => user?.discordId);
};

// (async () => {

// })();

// TODO: send a MP to the user to let hom know how much of boost he had from his role every end of epoch
// const sendDiscordMessage = async () => {};
