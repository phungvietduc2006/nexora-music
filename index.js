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
import os from "os";
import "dotenv/config";

// --- WEB SERVER KEEP ALIVE 24/7 ---
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

// --- CẤU HÌNH TỐI ƯU BỘ ĐỆM ÂM THANH CHỐNG GIẬT KHỰNG ---
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

// Danh sách Discord User ID của Admin
const ADMIN_USER_IDS = ["1073520375285166100"];

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

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

  // HỆ THỐNG LỆNH ADMIN
  new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Hệ thống quản trị Admin VIP")
    .addSubcommand((s) => s.setName("stats").setDescription("Kiểm tra thông số tài nguyên máy chủ Render"))
    .addSubcommand((s) => s.setName("clearqueue").setDescription("Xóa toàn bộ bài hát trong hàng chờ"))
    .addSubcommand((s) => s.setName("forceleave").setDescription("Buộc bot ngắt kết nối và rời phòng")),
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

// --- TẠO 4 NÚT ĐIỀU KHIỂN BÀI HÁT ---
function createMusicControls() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("music_pause").setLabel("⏸ Pause/Resume").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("music_skip").setLabel("⏭ Bỏ qua").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("music_queue").setLabel("📜 Hàng chờ").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("music_stop").setLabel("⏹ Dừng").setStyle(ButtonStyle.Danger)
  );
}

async function clearControls(player) {
  const msg = player?.metadata?.controlMessage;
  if (msg) {
    await msg.edit({ components: [] }).catch(() => {});
    player.metadata.controlMessage = null;
  }
}

// --- GIAO DIỆN HÀNG CHỜ KÈM MENU CHỌN TRANG & CHỌN BÀI HÁT TRỰC TIẾP ---
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

  // 2. Menu chọn bài hát phát ngay
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

  // 3. Menu chọn trang nhanh
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

// --- TỰ ĐỘNG GỬI BẢNG ĐIỀU KHIỂN KHI BÀI HÁT BẮT ĐẦU PHÁT ---
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
    console.error("[trackStart Error]", err);
  }
});

manager.on("queueEnd", async (player) => {
  await clearControls(player);
  player.metadata?.channel?.send("✅ Đã phát xong danh sách chờ!").catch(() => {});
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
      return message.reply(`🔍 Đã thêm bài hát vào hàng chờ!`);
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

    if (command === "stop") {
      const player = getPlayer(message.guild.id);
      if (!player) return message.reply("❌ Bot không trong kênh thoại!");
      await stopAndLeave(player);
      return message.reply("⏹️ Đã dừng nhạc.");
    }

    // --- XỬ LÝ LỆNH ADMIN TỪ PREFIX (!admin / !stats / !clear) ---
    if (command === "admin" || command === "stats" || command === "clear" || command === "leave") {
      if (!isAdmin(message.author.id)) {
        return message.reply("⛔ Bạn không có quyền sử dụng lệnh Admin!");
      }

      const sub = args[0]?.toLowerCase() || command;

      if (sub === "stats") {
        const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
        const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
        const uptime = Math.floor(process.uptime());

        const embed = new EmbedBuilder()
          .setColor("#FFD700")
          .setTitle("📊 Thông Số Tài Nguyên Máy Chủ Admin")
          .addFields(
            { name: "💾 Bộ nhớ RAM tiêu thụ", value: `${memoryUsage} MB / ${totalMem} GB`, inline: true },
            { name: "⏱️ Uptime", value: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`, inline: true },
            { name: "⚙️ Node.js Version", value: process.version, inline: true }
          );

        return message.reply({ embeds: [embed] });
      }

      if (sub === "clearqueue" || sub === "clear") {
        const player = getPlayer(message.guild.id);
        if (!player) return message.reply("❌ Bot không trong phòng thoại!");
        if (typeof player.queue.clear === "function") player.queue.clear();
        return message.reply("🧹 **[ADMIN]** Đã xói sạch toàn bộ danh sách chờ!");
      }

      if (sub === "forceleave" || sub === "leave") {
        const player = getPlayer(message.guild.id);
        if (!player) return message.reply("❌ Bot không trong phòng thoại!");
        await stopAndLeave(player);
        return message.reply("🛑 **[ADMIN]** Đã buộc bot rời phòng!");
      }
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

      if (commandName === "stop") {
        const player = getPlayer(interaction.guildId);
        if (!player) return interaction.reply({ content: "❌ Bot không trong phòng thoại!", flags: EPHEMERAL });
        await stopAndLeave(player);
        return interaction.reply("⏹️ Đã dừng nhạc.");
      }

      // --- XỬ LÝ LỆNH ADMIN TỪ SLASH (/admin) ---
      if (commandName === "admin") {
        if (!isAdmin(interaction.user.id)) {
          return interaction.reply({ content: "⛔ Bạn không có quyền Admin!", flags: EPHEMERAL });
        }

        const sub = interaction.options.getSubcommand();

        if (sub === "stats") {
          const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
          const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
          const uptime = Math.floor(process.uptime());

          const embed = new EmbedBuilder()
            .setColor("#FFD700")
            .setTitle("📊 Thông Số Tài Nguyên Máy Chủ Admin")
            .addFields(
              { name: "💾 Bộ nhớ RAM tiêu thụ", value: `${memoryUsage} MB / ${totalMem} GB`, inline: true },
              { name: "⏱️ Uptime", value: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`, inline: true },
              { name: "⚙️ Node.js Version", value: process.version, inline: true }
            );

          return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
        }

        if (sub === "clearqueue") {
          const player = getPlayer(interaction.guildId);
          if (!player) return interaction.reply({ content: "❌ Bot không trong phòng thoại!", flags: EPHEMERAL });
          if (typeof player.queue.clear === "function") player.queue.clear();
          return interaction.reply({ content: "🧹 **[ADMIN]** Đã xóa sạch toàn bộ hàng chờ!", flags: EPHEMERAL });
        }

        if (sub === "forceleave") {
          const player = getPlayer(interaction.guildId);
          if (!player) return interaction.reply({ content: "❌ Bot không trong phòng thoại!", flags: EPHEMERAL });
          await stopAndLeave(player);
          return interaction.reply({ content: "🛑 **[ADMIN]** Đã buộc bot rời phòng!", flags: EPHEMERAL });
        }
      }
    } catch (err) {
      console.error(`[Slash command error: ${commandName}]`, err);
    }
    return;
  }

  // --- XỬ LÝ NÚT BẤM VÀ CÁC MENU THẢ XUỐNG ---
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    const player = getPlayer(interaction.guildId);
    if (!player) return interaction.reply({ content: "❌ Bot không ở trong kênh thoại!", flags: EPHEMERAL });

    try {
      // 1. Phát trực tiếp 1 bài từ Menu chọn bài
      if (interaction.isStringSelectMenu() && interaction.customId === "q_play_track_menu") {
        const targetPos = parseInt(interaction.values[0].split("_")[1]) || 1;
        await skipToPosition(player, targetPos);
        return interaction.reply({ content: `⏩ Đã phát ngay bài hát số **${targetPos}**!`, flags: EPHEMERAL });
      }

      // 2. Chuyển trang queue từ Menu chọn trang
      if (interaction.isStringSelectMenu() && interaction.customId === "q_jump_menu") {
        const targetPage = parseInt(interaction.values[0].split("_")[1]) || 1;
        return interaction.update(buildQueuePage(player, targetPage));
      }

      // 3. Nút phân trang queue (<< < > >>)
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

      // 4. Nút bấm điều khiển nhạc (Pause, Skip, Queue, Stop)
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
      console.error("[Interaction error]", err);
    }
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ NEXORA MUSIC VIP sẵn sàng: ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("🚀 Slash Commands đã sẵn sàng!");
  } catch (error) {
    console.error("❌ Slash command error:", error);
  }
});

client.login(process.env.DISCORD_TOKEN);
