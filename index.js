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

// --- WEB SERVER UPTIME 24/7 ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("NEXORA MUSIC VIP 24/7 is Running!"));
app.listen(PORT, () => console.log(`🌐 Web Server running on port ${PORT}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

new PlayerManager({
  plugins: [
    new YouTubePlugin(),
    new SoundCloudPlugin(),
    new SpotifyPlugin(),
    new TTSPlugin({ defaultLang: "vi" }),
    new AttachmentsPlugin({ maxFileSize: 25 * 1024 * 1024 }),
  ],
  autoCleanup: true,
  // Thêm cấu hình tối ưu âm thanh chống giật lag, khựng tiếng
  audioOptions: {
    highWaterMark: 1 << 25, // Tăng kích thước bộ đệm (buffer) lên tối đa
    opusEncoding: {
      bitrate: 96, // Tối ưu hóa tốc độ bit âm thanh ổn định trên server cloud
    }
  }
});

const manager = getManager();
const PREFIX = process.env.PREFIX || "!";
const EPHEMERAL = MessageFlags.Ephemeral;

const ADMIN_USER_IDS = ["1073520375285166100"];

// --- HÀM XỬ LÝ LINK SOUNDCLOUD AN TOÀN (CHỐNG LỖI MẤT KẾT NỐI) ---
async function resolveQuery(query) {
  if (typeof query === "string" && query.includes("on.soundcloud.com")) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      
      const res = await fetch(query, { 
        method: "HEAD", 
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      clearTimeout(timeoutId);
      
      if (res.url && !res.url.includes("on.soundcloud.com")) {
        return res.url;
      }
    } catch (e) {
      console.error("[SoundCloud Unshorten Warning]:", e.message);
    }
  }
  return query;
}

// --- 1. ĐỊNH NGHĨA SLASH COMMANDS ---
const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Phát nhạc từ YouTube, SoundCloud, Spotify")
    .addStringOption((option) =>
      option.setName("query").setDescription("Tên bài hát hoặc URL").setRequired(true)
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Bỏ qua bài hát hiện tại"),
  
  new SlashCommandBuilder()
    .setName("skipto")
    .setDescription("Nhảy cóc phát thẳng tới số thứ tự bài hát trong hàng chờ")
    .addIntegerOption((option) =>
      option.setName("position").setDescription("Số thứ tự bài hát trong hàng chờ").setRequired(true).setMinValue(1)
    ),

  new SlashCommandBuilder().setName("queue").setDescription("Xem danh sách hàng chờ (Phân trang & Menu chọn trang)"),
  new SlashCommandBuilder().setName("stop").setDescription("Dừng nhạc và rời phòng"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Xem thông tin bài đang phát"),
  new SlashCommandBuilder().setName("shuffle").setDescription("Trộn ngẫu nhiên hàng chờ"),
  
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Thay đổi âm lượng")
    .addIntegerOption((option) =>
      option.setName("level").setDescription("Âm lượng (1 - 100)").setRequired(true).setMinValue(1).setMaxValue(100)
    ),

  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Cài đặt lặp lại")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Kiểu lặp")
        .setRequired(true)
        .addChoices(
          { name: "🔂 Bài hiện tại", value: "track" },
          { name: "🔁 Toàn bộ hàng chờ", value: "queue" },
          { name: "➡️ Tắt lặp", value: "off" }
        )
    ),

  new SlashCommandBuilder()
    .setName("filter")
    .setDescription("Chỉnh hiệu ứng âm thanh")
    .addStringOption((option) =>
      option
        .setName("preset")
        .setDescription("Chọn hiệu ứng")
        .setRequired(true)
        .addChoices(
          { name: "🔊 Bassboost", value: "bassboost" },
          { name: "⚡ Nightcore", value: "nightcore" },
          { name: "🎧 8D", value: "8d" },
          { name: "❌ Tắt hiệu ứng", value: "clear" }
        )
    ),

  new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Hệ thống quản trị Admin")
    .addSubcommand((s) => s.setName("stats").setDescription("Trạng thái tài nguyên"))
    .addSubcommand((s) => s.setName("clearqueue").setDescription("Xóa sạch hàng chờ"))
    .addSubcommand((s) => s.setName("forceleave").setDescription("Buộc bot rời phòng")),
].map((cmd) => cmd.toJSON());

function resolveUserMention(req, fallbackId) {
  const pick = (v) => {
    if (!v) return null;
    if (typeof v === "string") return `<@${v}>`;
    if (typeof v === "object") {
      const id = v.id || v.userId || v.user?.id;
      if (id) return `<@${id}>`;
      if (v.username) return `**${v.username}**`;
    }
    return null;
  };
  return pick(req) || pick(fallbackId) || "Không xác định";
}

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

// --- HÀM TẠO GIAO DIỆN HÀNG CHỜ KÈM NÚT & MENU CHỌN TRANG ---
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
    desc += "*Hàng chờ đang trống.*";
  } else {
    pageTracks.forEach((t, i) => {
      const index = startIdx + i + 1;
      const durationStr = formatDuration(t.duration);
      desc += `\`${index}.\` [\`${durationStr}\`] **${t.title}**\n`;
    });
  }

  const embed = new EmbedBuilder()
    .setColor("#1E90FF")
    .setTitle(`📜 Hàng Chờ Phát Nhạc (Trang ${currentPage}/${totalPages})`)
    .setDescription(desc)
    .setFooter({ text: `Tổng số bài hát: ${totalTracks} bài` });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`q_first_${currentPage}`).setLabel("<<").setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 1),
    new ButtonBuilder().setCustomId(`q_prev_${currentPage}`).setLabel("<").setStyle(ButtonStyle.Primary).setDisabled(currentPage === 1),
    new ButtonBuilder().setCustomId(`q_next_${currentPage}`).setLabel(">").setStyle(ButtonStyle.Primary).setDisabled(currentPage === totalPages),
    new ButtonBuilder().setCustomId(`q_last_${currentPage}`).setLabel(">>").setStyle(ButtonStyle.Secondary).setDisabled(currentPage === totalPages)
  );

  const componentsArray = [buttons];

  if (totalPages > 1) {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("q_jump_menu")
      .setPlaceholder("📌 Chọn trang hàng chờ nhanh...");

    const options = [];
    for (let i = 1; i <= Math.min(25, totalPages); i++) {
      options.push(
        new StringSelectMenuOptionBuilder()
          .setLabel(`Trang ${i}`)
          .setValue(`page_${i}`)
          .setDescription(`Xem các bài từ số ${(i - 1) * pageSize + 1}`)
          .setDefault(i === currentPage)
      );
    }
    selectMenu.addOptions(options);
    componentsArray.push(new ActionRowBuilder().addComponents(selectMenu));
  }

  return { embeds: [embed], components: componentsArray };
}

function createMusicControls() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("music_pause").setLabel("⏸️ Pause/Resume").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("music_skip").setLabel("⏭️ Bỏ qua").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("music_queue").setLabel("📜 Hàng chờ").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("music_stop").setLabel("⏹️ Dừng").setStyle(ButtonStyle.Danger)
  );
}

async function clearControls(player) {
  const msg = player?.metadata?.controlMessage;
  if (msg) {
    await msg.edit({ components: [] }).catch(() => {});
    player.metadata.controlMessage = null;
  }
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
  player.metadata.lastRequesterId = userId;
  return player;
}

async function enqueue({ guildId, textChannel, voiceChannel, userId, query }) {
  const finalQuery = await resolveQuery(query);
  const player = await getOrCreatePlayer(guildId, textChannel, userId);
  if (!player.connection) await player.connect(voiceChannel);
  return player.play(finalQuery, userId);
}

async function stopAndLeave(player) {
  await clearControls(player);
  await player.stop();
  await player.destroy();
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
    await clearControls(player);
    const userMention = resolveUserMention(track.requestedBy, player.metadata?.lastRequesterId);
    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle("🎵 Đang Phát Bài Hát Mới")
      .setDescription(track.url ? `[**${track.title}**](${track.url})` : `**${track.title}**`)
      .addFields(
        { name: "⏱️ Thời lượng", value: formatDuration(track.duration), inline: true },
        { name: "🔊 Âm lượng", value: `${player.volume || 80}%`, inline: true },
        { name: "👤 Yêu cầu bởi", value: userMention, inline: true }
      )
      .setThumbnail(track.thumbnail || null)
      .setFooter({ text: "Nexora Music VIP" });

    player.metadata.controlMessage = await channel.send({
      embeds: [embed],
      components: [createMusicControls()],
    });
  } catch (err) {
    console.error("[trackStart]", err);
  }
});

manager.on("queueEnd", async (player) => {
  await clearControls(player);
  player.metadata?.channel?.send("✅ Đã phát xong danh sách chờ!").catch(() => {});
});

manager.on("playerError", (player, error) => {
  console.error(`[Error Guild ${player.id}]:`, error);
  player.metadata?.channel?.send(`⚠️ Lỗi nhạc: ${error?.message || error}`).catch(() => {});
});

// --- PREFIX COMMANDS ---
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/g);
  const command = args.shift()?.toLowerCase();
  const voiceChannel = message.member?.voice?.channel;

  try {
    if (command === "play" || command === "p") {
      if (!voiceChannel) return message.reply("❌ Bạn phải vào một kênh thoại trước!");
      const rawQuery = args.join(" ");
      if (!rawQuery && message.attachments.size === 0) return message.reply("❌ Vui lòng nhập tên bài hát hoặc link!");

      const ok = await enqueue({
        guildId: message.guild.id,
        textChannel: message.channel,
        voiceChannel,
        userId: message.author.id,
        query: message.attachments.first()?.url || rawQuery,
      });
      if (!ok) return message.reply("❌ Không tìm thấy kết quả hợp lệ.");
      return message.reply(`🔍 Đã thêm bài hát vào hàng chờ!`);
    }

    if (command === "skip" || command === "s") {
      const player = getPlayer(message.guild.id);
      if (!player || !player.currentTrack) return message.reply("❌ Không có bài nào đang phát!");
      await player.skip();
      return message.reply("⏭️ Đã chuyển bài!");
    }

    if (command === "skipto") {
      const player = getPlayer(message.guild.id);
      if (!player || !player.currentTrack) return message.reply("❌ Hàng chờ đang trống!");
      const pos = parseInt(args[0]);
      if (isNaN(pos)) return message.reply("❌ Vui lòng nhập số thứ tự bài hát hợp lệ!");
      const success = await skipToPosition(player, pos);
      if (!success) return message.reply("❌ Vị trí bài hát không tồn tại trong hàng chờ!");
      return message.reply(`⏩ Đã nhảy cóc tới bài hát số **${pos}**!`);
    }

    if (command === "stop") {
      const player = getPlayer(message.guild.id);
      if (!player) return message.reply("❌ Bot không trong phòng thoại!");
      await stopAndLeave(player);
      return message.reply("⏹️ Đã dừng nhạc.");
    }

    if (command === "queue" || command === "q") {
      const player = getPlayer(message.guild.id);
      if (!player || !player.currentTrack) return message.reply("🎶 Hàng chờ đang trống.");
      return message.reply(buildQueuePage(player, 1));
    }
  } catch (err) {
    console.error(`[prefix:${command}]`, err);
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
        if (!voiceChannel) return interaction.reply({ content: "❌ Bạn phải vào một kênh thoại trước!", flags: EPHEMERAL });
        await interaction.deferReply();
        const ok = await enqueue({
          guildId: interaction.guildId,
          textChannel: interaction.channel,
          voiceChannel,
          userId: interaction.user.id,
          query: interaction.options.getString("query", true),
        });
        if (!ok) return interaction.editReply("❌ Không tìm thấy kết quả.");
        return interaction.editReply(`🔍 Đã thêm bài hát vào hàng chờ!`);
      }

      if (commandName === "queue") {
        const player = getPlayer(interaction.guildId);
        if (!player || !player.currentTrack) return interaction.reply({ content: "🎶 Hàng chờ đang trống.", flags: EPHEMERAL });
        return interaction.reply({ ...buildQueuePage(player, 1), flags: EPHEMERAL });
      }

      if (commandName === "skip") {
        const player = getPlayer(interaction.guildId);
        if (!player || !player.currentTrack) return interaction.reply({ content: "❌ Không có bài đang phát!", flags: EPHEMERAL });
        await player.skip();
        return interaction.reply("⏭️ Đã chuyển bài!");
      }

      if (commandName === "skipto") {
        const player = getPlayer(interaction.guildId);
        if (!player || !player.currentTrack) return interaction.reply({ content: "❌ Hàng chờ trống!", flags: EPHEMERAL });
        const pos = interaction.options.getInteger("position", true);
        const success = await skipToPosition(player, pos);
        if (!success) return interaction.reply({ content: "❌ Vị trí bài hát không hợp lệ!", flags: EPHEMERAL });
        return interaction.reply(`⏩ Đã nhảy cóc phát thẳng tới bài số **${pos}**!`);
      }

      if (commandName === "stop") {
        const player = getPlayer(interaction.guildId);
        if (!player) return interaction.reply({ content: "❌ Bot không trong phòng thoại!", flags: EPHEMERAL });
        await stopAndLeave(player);
        return interaction.reply("⏹️ Đã dừng nhạc.");
      }
    } catch (err) {
      console.error(`[slash:${commandName}]`, err);
    }
    return;
  }

  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    const player = getPlayer(interaction.guildId);
    if (!player) return interaction.reply({ content: "❌ Bot không trong kênh thoại!", flags: EPHEMERAL });

    try {
      if (interaction.isStringSelectMenu() && interaction.customId === "q_jump_menu") {
        const selectedValue = interaction.values[0];
        const targetPage = parseInt(selectedValue.split("_")[1]) || 1;
        return interaction.update(buildQueuePage(player, targetPage));
      }

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

      if (interaction.isButton() && interaction.customId.startsWith("music_")) {
        const id = interaction.customId;
        if (id === "music_queue") {
          return interaction.reply({ ...buildQueuePage(player, 1), flags: EPHEMERAL });
        }

        await interaction.deferUpdate().catch(() => {});
        if (id === "music_pause") {
          if (!player.pause()) player.resume();
        } else if (id === "music_skip") {
          await player.skip();
        } else if (id === "music_stop") {
          await stopAndLeave(player);
        }
      }
    } catch (err) {
      console.error(`[interaction:${interaction.customId}]`, err);
    }
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ NEXORA MUSIC VIP sẵn sàng: ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("🚀 Đăng ký Slash Commands thành công!");
  } catch (error) {
    console.error("❌ Lỗi Slash Commands:", error);
  }
});

process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

client.login(process.env.DISCORD_TOKEN);
