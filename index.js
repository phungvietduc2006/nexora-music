import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  Events,
} from "discord.js";
import { PlayerManager, getManager, getPlayer } from "ziplayer";
import {
  YouTubePlugin,
  SoundCloudPlugin,
  SpotifyPlugin,
  TTSPlugin,
  AttachmentsPlugin,
} from "@ziplayer/plugin";
import express from "express";
import "dotenv/config";

// --- WEB SERVER KEEP ALIVE 24/7 ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("JOCKIE STYLE MUSIC BOT IS ONLINE 24/7!"));
app.listen(PORT, () => console.log(`🌐 Web Server active on port ${PORT}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- CẤU HÌNH PLAYERMANAGER TỐI ƯU BỘ ĐỆM ÂM THANH CHỐNG LAG ---
new PlayerManager({
  plugins: [
    new YouTubePlugin(),
    new SoundCloudPlugin(),
    new SpotifyPlugin(),
    new TTSPlugin({ defaultLang: "vi" }),
    new AttachmentsPlugin({ maxFileSize: 25 * 1024 * 1024 }),
  ],
  autoCleanup: true,
  ytdlOptions: {
    highWaterMark: 1 << 26, 
    filter: "audioonly",
    quality: "highestaudio",
  },
});

const manager = getManager();
const PREFIX = process.env.PREFIX || "!";
const EPHEMERAL = MessageFlags.Ephemeral;

// --- HÀM GIẢI MÃ LINK SOUNDCLOUD RÚT GỌN (on.soundcloud.com) ---
async function resolveQuery(query) {
  if (typeof query === "string" && query.includes("on.soundcloud.com")) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      
      const res = await fetch(query, { 
        method: "HEAD", 
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      clearTimeout(timeoutId);
      
      if (res.url && !res.url.includes("on.soundcloud.com")) {
        return res.url;
      }
    } catch (e) {
      console.error("[SoundCloud Resolve Warning]:", e.message);
    }
  }
  return query;
}

// --- SLASH COMMANDS DEFINITION ---
const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Phát nhạc từ YouTube, SoundCloud, Spotify")
    .addStringOption((option) =>
      option.setName("query").setDescription("Link hoặc tên bài hát").setRequired(true)
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Bỏ qua bài hát hiện tại"),
  new SlashCommandBuilder()
    .setName("skipto")
    .setDescription("Nhảy thẳng tới vị trí bài hát trong danh sách chờ")
    .addIntegerOption((option) =>
      option.setName("position").setDescription("Số thứ tự trong hàng chờ").setRequired(true).setMinValue(1)
    ),
  new SlashCommandBuilder().setName("queue").setDescription("Xem danh sách hàng chờ"),
  new SlashCommandBuilder().setName("stop").setDescription("Dừng nhạc và rời kênh thoại"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Xem bài hát đang phát"),
  new SlashCommandBuilder().setName("shuffle").setDescription("Trộn bài hát trong hàng chờ"),
].map((cmd) => cmd.toJSON());

function formatDuration(sec) {
  const n = Number(sec);
  if (!n || n <= 0) return "Live";
  const pad = (x) => String(x).padStart(2, "0");
  const h = Math.floor(n / 3600);
  const m = Math.floor((n / 60) % 60);
  const s = Math.floor(n % 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function getAllQueueTracks(player) {
  const q = player.queue;
  if (!q) return [];
  if (typeof q.toArray === "function") return q.toArray();
  if (Array.isArray(q.tracks)) return q.tracks;
  let list = [];
  if (typeof q.getTrack === "function") {
    for (let i = 0; i < (q.size || 0); i++) {
      const t = q.getTrack(i);
      if (t) list.push(t);
    }
  }
  return list;
}

// --- GIAO DIỆN HÀNG CHỜ KÈM MENU CHỌN TRANG + MENU CHỌN BÀI HÁT TỨC THÌ ---
function buildQueuePage(player, page = 1, pageSize = 10) {
  const tracks = getAllQueueTracks(player);
  const totalTracks = tracks.length;
  const totalPages = Math.ceil(totalTracks / pageSize) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIdx = (currentPage - 1) * pageSize;
  const pageTracks = tracks.slice(startIdx, startIdx + pageSize);

  const current = player.currentTrack;
  let desc = `**Đang phát:** ${current ? `[${current.title}](${current.url || "#"})` : "Không có"}\n\n`;

  if (pageTracks.length === 0) {
    desc += "*Hàng chờ trống.*";
  } else {
    pageTracks.forEach((t, i) => {
      const index = startIdx + i + 1;
      const durationStr = formatDuration(t.duration);
      desc += `${index}. [${durationStr}] [${t.title}](${t.url || "#"})\n`;
    });
  }

  const embed = new EmbedBuilder()
    .setColor("#2b2d31")
    .setTitle(`Page ${currentPage}/${totalPages}`)
    .setDescription(desc)
    .setFooter({ text: `next page | previous page | go to page <page> | cancel` });

  // 1. Nút điều hướng << < > >>
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`q_first_${currentPage}`).setLabel("<<").setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 1),
    new ButtonBuilder().setCustomId(`q_prev_${currentPage}`).setLabel("<").setStyle(ButtonStyle.Primary).setDisabled(currentPage === 1),
    new ButtonBuilder().setCustomId(`q_next_${currentPage}`).setLabel(">").setStyle(ButtonStyle.Primary).setDisabled(currentPage === totalPages),
    new ButtonBuilder().setCustomId(`q_last_${currentPage}`).setLabel(">>").setStyle(ButtonStyle.Secondary).setDisabled(currentPage === totalPages)
  );

  const componentsArray = [buttons];

  // 2. Menu chọn bài hát trực tiếp (Select Track) từ trang hiện tại
  if (pageTracks.length > 0) {
    const trackSelectMenu = new StringSelectMenuBuilder()
      .setCustomId("q_play_track_menu")
      .setPlaceholder("🎵 Chọn phát ngay 1 bài trong trang này...");

    const trackOptions = pageTracks.map((t, i) => {
      const realIndex = startIdx + i + 1;
      const titleShort = t.title.length > 50 ? t.title.substring(0, 47) + "..." : t.title;
      return new StringSelectMenuOptionBuilder()
        .setLabel(`${realIndex}. ${titleShort}`)
        .setValue(`trackpos_${realIndex}`)
        .setDescription(`Thời lượng: ${formatDuration(t.duration)}`);
    });

    trackSelectMenu.addOptions(trackOptions);
    componentsArray.push(new ActionRowBuilder().addComponents(trackSelectMenu));
  }

  // 3. Menu thả xuống chọn trang nhanh (Jump Page)
  if (totalPages > 1) {
    const pageSelectMenu = new StringSelectMenuBuilder()
      .setCustomId("q_jump_menu")
      .setPlaceholder("Đưa ra lựa chọn");

    const pageOptions = [];
    for (let i = 1; i <= Math.min(25, totalPages); i++) {
      pageOptions.push(
        new StringSelectMenuOptionBuilder()
          .setLabel(`Trang ${i}`)
          .setValue(`page_${i}`)
          .setDefault(i === currentPage)
      );
    }
    pageSelectMenu.addOptions(pageOptions);
    componentsArray.push(new ActionRowBuilder().addComponents(pageSelectMenu));
  }

  return { embeds: [embed], components: componentsArray };
}

async function getOrCreatePlayer(guildId, channel, userId) {
  let player = getPlayer(guildId);
  if (!player) {
    player = await manager.create(guildId, {
      leaveOnEnd: true,
      leaveOnEmpty: true,
      volume: 80,
    });
  }
  if (!player.metadata) player.metadata = {};
  player.metadata.channel = channel;
  return player;
}

async function enqueue({ guildId, textChannel, voiceChannel, userId, query }) {
  const finalQuery = await resolveQuery(query);
  const player = await getOrCreatePlayer(guildId, textChannel, userId);
  if (!player.connection) await player.connect(voiceChannel);
  return player.play(finalQuery, userId);
}

async function skipToPosition(player, position) {
  const tracks = getAllQueueTracks(player);
  if (position < 1 || position > tracks.length) return false;
  if (typeof player.queue.remove === "function") {
    for (let i = 0; i < position - 1; i++) {
      player.queue.remove(0);
    }
  }
  await player.skip();
  return true;
}

manager.on("trackStart", async (player, track) => {
  const channel = player.metadata?.channel;
  if (!channel) return;

  try {
    const embed = new EmbedBuilder()
      .setColor("#ff5500")
      .setDescription(`🟠 **Started playing** [${track.title}](${track.url || "#"})`);

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("[trackStart Error]", err);
  }
});

// --- PREFIX COMMANDS ---
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/g);
  const command = args.shift()?.toLowerCase();
  const voiceChannel = message.member?.voice?.channel;

  try {
    if (command === "play" || command === "p" || command === "m!q" || command === "q" || command === "queue") {
      if (command === "m!q" || command === "q" || command === "queue") {
        const player = getPlayer(message.guild.id);
        if (!player || !player.currentTrack) return message.reply("🎶 Hàng chờ đang trống.");
        return message.reply(buildQueuePage(player, 1));
      }

      if (!voiceChannel) return message.reply("❌ Bạn phải vào một kênh thoại trước!");
      const rawQuery = args.join(" ");
      if (!rawQuery) return message.reply("❌ Vui lòng nhập link hoặc tên bài!");

      const ok = await enqueue({
        guildId: message.guild.id,
        textChannel: message.channel,
        voiceChannel,
        userId: message.author.id,
        query: rawQuery,
      });
      if (!ok) return message.reply("❌ Không tìm thấy kết quả hợp lệ.");
    }

    if (command === "skipto") {
      const player = getPlayer(message.guild.id);
      if (!player || !player.currentTrack) return message.reply("❌ Hàng chờ trống!");
      const pos = parseInt(args[0]);
      if (isNaN(pos)) return message.reply("❌ Vui lòng nhập số vị trí hợp lệ!");
      const success = await skipToPosition(player, pos);
      if (!success) return message.reply("❌ Vị trí không hợp lệ!");
      return message.reply(`⏩ Đã chuyển đến bài số **${pos}**!`);
    }

    if (command === "skip" || command === "s") {
      const player = getPlayer(message.guild.id);
      if (!player || !player.currentTrack) return message.reply("❌ Không có bài đang phát!");
      await player.skip();
      return message.reply("⏭️ Đã chuyển bài!");
    }
  } catch (err) {
    console.error(`[Prefix error: ${command}]`, err);
  }
});

// --- SLASH COMMANDS & INTERACTIONS ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.guild) return;

  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;
    const voiceChannel = interaction.member?.voice?.channel;

    try {
      if (commandName === "play") {
        if (!voiceChannel) return interaction.reply({ content: "❌ Bạn phải vào kênh thoại trước!", flags: EPHEMERAL });
        await interaction.deferReply();
        const ok = await enqueue({
          guildId: interaction.guildId,
          textChannel: interaction.channel,
          voiceChannel,
          userId: interaction.user.id,
          query: interaction.options.getString("query", true),
        });
        if (!ok) return interaction.editReply("❌ Không tìm thấy kết quả.");
        return interaction.editReply("🔍 Đã thêm vào hàng chờ!");
      }

      if (commandName === "queue") {
        const player = getPlayer(interaction.guildId);
        if (!player || !player.currentTrack) return interaction.reply({ content: "🎶 Hàng chờ trống.", flags: EPHEMERAL });
        return interaction.reply({ ...buildQueuePage(player, 1), flags: EPHEMERAL });
      }

      if (commandName === "skipto") {
        const player = getPlayer(interaction.guildId);
        if (!player || !player.currentTrack) return interaction.reply({ content: "❌ Hàng chờ trống!", flags: EPHEMERAL });
        const pos = interaction.options.getInteger("position", true);
        const success = await skipToPosition(player, pos);
        if (!success) return interaction.reply({ content: "❌ Vị trí không hợp lệ!", flags: EPHEMERAL });
        return interaction.reply(`⏩ Đã nhảy thẳng tới bài số **${pos}**!`);
      }
    } catch (err) {
      console.error(`[Slash command error: ${commandName}]`, err);
    }
    return;
  }

  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    const player = getPlayer(interaction.guildId);
    if (!player) return interaction.reply({ content: "❌ Bot không ở trong kênh thoại!", flags: EPHEMERAL });

    try {
      // 1. Xử lý chọn phát bài hát trực tiếp từ Menu
      if (interaction.isStringSelectMenu() && interaction.customId === "q_play_track_menu") {
        const selectedValue = interaction.values[0]; // dạng "trackpos_15"
        const targetPos = parseInt(selectedValue.split("_")[1]) || 1;
        
        await skipToPosition(player, targetPos);
        return interaction.reply({ content: `⏩ Đã phát ngay bài hát số **${targetPos}**!`, flags: EPHEMERAL });
      }

      // 2. Xử lý Menu chọn trang
      if (interaction.isStringSelectMenu() && interaction.customId === "q_jump_menu") {
        const targetPage = parseInt(interaction.values[0].split("_")[1]) || 1;
        return interaction.update(buildQueuePage(player, targetPage));
      }

      // 3. Xử lý Nút bấm điều hướng << < > >>
      if (interaction.isButton() && interaction.customId.startsWith("q_")) {
        const parts = interaction.customId.split("_");
        const action = parts[1];
        let currentPage = parseInt(parts[2]) || 1;

        const tracks = getAllQueueTracks(player);
        const totalPages = Math.ceil(tracks.length / 10) || 1;

        if (action === "first") currentPage = 1;
        else if (action === "prev") currentPage = Math.max(1, currentPage - 1);
        else if (action === "next") currentPage = Math.min(totalPages, currentPage + 1);
        else if (action === "last") currentPage = totalPages;

        return interaction.update(buildQueuePage(player, currentPage));
      }
    } catch (err) {
      console.error("[Interaction error]", err);
    }
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Jockie Style Bot sẵn sàng: ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("🚀 Slash Commands đã sẵn sàng!");
  } catch (error) {
    console.error("❌ Slash command error:", error);
  }
});

client.login(process.env.DISCORD_TOKEN);
