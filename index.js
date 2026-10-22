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
import { PlayerManager } from "ziplayer";
import {
  YouTubePlugin,
  SoundCloudPlugin,
  SpotifyPlugin,
  TTSPlugin,
  AttachmentsPlugin,
} from "@ziplayer/plugin";
import express from "express";
import "dotenv/config";

// ============================================================
// NEXORA MUSIC VIP — optimized bot entry point
// Requires Node.js 20+ and an ESM project ("type": "module").
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const PREFIX = process.env.PREFIX || "!";
const PORT = Number(process.env.PORT) || 3000;
const EPHEMERAL = MessageFlags.Ephemeral;
const QUEUE_PAGE_SIZE = 10;
const MAX_TITLE_LENGTH = 180;

// Put comma-separated Discord user IDs in ADMIN_USER_IDS in the environment.
// The existing ID is retained as a fallback so the current configuration keeps working.
const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS || "1073520375285166100")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

function isAdmin(userId) {
  return ADMIN_USER_IDS.has(userId);
}

// Health-check endpoint for hosting providers. This does not itself guarantee
// that a hosting provider's free instance will stay awake 24/7.
const app = express();
app.disable("x-powered-by");
app.get("/", (_req, res) => {
  res.status(200).send("NEXORA MUSIC VIP is running.");
});
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
});

const webServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Health server listening on port ${PORT}`);
});
webServer.on("error", (error) => {
  console.error("[Web server error]", error);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Register specific matchers (TTS and attachments) before general search plugins.
// Low-performance mode avoids extra preload/crossfade work on small cloud instances.
const manager = new PlayerManager({
  plugins: [
    new TTSPlugin({ defaultLang: "vi" }),
    new AttachmentsPlugin({ maxFileSize: 25 * 1024 * 1024 }),
    new YouTubePlugin(),
    new SoundCloudPlugin(),
    new SpotifyPlugin(),
  ],
  autoCleanup: true,
  cleanupInterval: 120_000,
  extractorTimeout: 30_000,
  enableSearchCache: true,
});

// --------------------------- Utilities ---------------------------

function ensureUserdata(player) {
  if (!player.userdata || typeof player.userdata !== "object") {
    player.userdata = {};
  }
  return player.userdata;
}

function getPlayerForGuild(guildId) {
  return manager.get(guildId) ?? null;
}

function getCurrentTrack(player) {
  return player?.currentTrack ?? player?.queue?.currentTrack ?? null;
}

function safeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function clipText(value, maxLength = MAX_TITLE_LENGTH) {
  const text = String(value ?? "Không rõ tên").trim() || "Không rõ tên";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/[\\`*_{}\[\]()<>#+\-.!|~]/g, "\\$&");
}

// ZiPlayer track durations are milliseconds (e.g. 300000 = 5 minutes).
function formatDuration(durationMs) {
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value <= 0) return "LIVE";

  const totalSeconds = Math.floor(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (number) => String(number).padStart(2, "0");

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

function resolveUserMention(requester, fallbackId) {
  const pick = (value) => {
    if (!value) return null;
    if (typeof value === "string") return /^\d{17,20}$/.test(value) ? `<@${value}>` : null;
    if (typeof value === "object") {
      const id = value.id || value.userId || value.user?.id;
      if (id && /^\d{17,20}$/.test(String(id))) return `<@${id}>`;
      if (value.username) return `**${clipText(value.username, 80)}**`;
    }
    return null;
  };
  return pick(requester) || pick(fallbackId) || "Không xác định";
}

async function resolveQuery(query) {
  const input = String(query ?? "").trim();
  if (!input) return input;
  if (!input.includes("on.soundcloud.com")) return input;

  let timeoutId;
  try {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 4_000);
    const response = await fetch(input, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const resolvedUrl = safeHttpUrl(response.url);
    return resolvedUrl && !resolvedUrl.includes("on.soundcloud.com") ? resolvedUrl : input;
  } catch (error) {
    console.warn("[SoundCloud resolve warning]", error?.message || error);
    return input;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function getAllQueueTracks(player) {
  const queue = player?.queue;
  if (!queue) return [];

  if (typeof queue.toArray === "function") {
    const tracks = queue.toArray();
    if (Array.isArray(tracks)) return tracks;
  }
  if (Array.isArray(queue.tracks)) return queue.tracks;

  const size = Number(queue.size) || 0;
  if (typeof queue.getTrack === "function" && size > 0) {
    const tracks = [];
    for (let index = 0; index < size; index += 1) {
      const track = queue.getTrack(index);
      if (track) tracks.push(track);
    }
    return tracks;
  }
  return [];
}

function memberIsInPlayerVoice(member, player) {
  const memberChannelId = member?.voice?.channelId;
  const playerChannelId = player?.userdata?.voiceChannelId;
  return Boolean(memberChannelId && playerChannelId && memberChannelId === playerChannelId);
}

async function requireSameVoiceForMessage(message, player) {
  if (memberIsInPlayerVoice(message.member, player)) return true;
  await message.reply("❌ Bạn cần ở cùng kênh thoại với bot để điều khiển nhạc.").catch(() => {});
  return false;
}

async function requireSameVoiceForInteraction(interaction, player) {
  if (memberIsInPlayerVoice(interaction.member, player)) return true;
  await interaction.reply({
    content: "❌ Bạn cần ở cùng kênh thoại với bot để điều khiển nhạc.",
    flags: EPHEMERAL,
  }).catch(() => {});
  return false;
}

async function sendInteractionError(interaction, message) {
  const payload = { content: message, flags: EPHEMERAL };
  try {
    if (interaction.isChatInputCommand?.() && interaction.deferred) {
      await interaction.editReply({ content: message });
    } else if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch {
    // Interaction may have expired or already been acknowledged.
  }
}

function getSafeErrorMessage(error) {
  if (error?.message === "VOICE_CHANNEL_MISMATCH") {
    return "❌ Bot đang phát ở kênh thoại khác. Hãy dùng bot trong cùng kênh với người đang nghe.";
  }
  return "❌ Có lỗi khi xử lý yêu cầu. Hãy thử lại sau.";
}

// --------------------------- Slash commands ---------------------------

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Phát nhạc từ YouTube, SoundCloud hoặc Spotify")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Link hoặc tên bài hát")
        .setRequired(true)
        .setMaxLength(500),
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Bỏ qua bài hát hiện tại"),
  new SlashCommandBuilder()
    .setName("skipto")
    .setDescription("Phát bài ở vị trí đã chọn trong hàng chờ")
    .addIntegerOption((option) =>
      option
        .setName("position")
        .setDescription("Vị trí bài trong hàng chờ, bắt đầu từ 1")
        .setRequired(true)
        .setMinValue(1),
    ),
  new SlashCommandBuilder().setName("queue").setDescription("Xem danh sách hàng chờ"),
  new SlashCommandBuilder().setName("stop").setDescription("Dừng nhạc và rời kênh thoại"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Xem bài hát đang phát"),
  new SlashCommandBuilder().setName("shuffle").setDescription("Trộn bài trong hàng chờ"),
  new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Hệ thống quản trị Admin")
    .addSubcommand((sub) => sub.setName("stats").setDescription("Xem tài nguyên bot"))
    .addSubcommand((sub) => sub.setName("clearqueue").setDescription("Xóa toàn bộ hàng chờ"))
    .addSubcommand((sub) => sub.setName("forceleave").setDescription("Buộc bot dừng và rời phòng")),
].map((command) => command.toJSON());

// --------------------------- Player lifecycle ---------------------------

async function getOrCreatePlayer({ guildId, textChannel, voiceChannel, userId }) {
  let player = getPlayerForGuild(guildId);

  if (
    player?.userdata?.voiceChannelId &&
    player.userdata.voiceChannelId !== voiceChannel.id
  ) {
    throw new Error("VOICE_CHANNEL_MISMATCH");
  }

  if (!player) {
    player = await manager.create(guildId, {
      leaveOnEnd: true,
      leaveOnEmpty: true,
      pauseOnEmpty: false,
      selfDeaf: true,
      volume: 80,
      lowPerformance: true,
      preload: { enabled: false },
      crossfade: { enabled: false },
      userdata: {
        channel: textChannel,
        lastRequesterId: userId,
        voiceChannelId: voiceChannel.id,
        paused: false,
        suppressQueueEnd: false,
      },
    });
  }

  const userdata = ensureUserdata(player);
  userdata.channel = textChannel;
  userdata.lastRequesterId = userId;
  userdata.voiceChannelId = voiceChannel.id;
  if (typeof userdata.paused !== "boolean") userdata.paused = false;
  if (typeof userdata.suppressQueueEnd !== "boolean") userdata.suppressQueueEnd = false;

  if (!player.connection) {
    await player.connect(voiceChannel);
    userdata.voiceChannelId = voiceChannel.id;
  }
  return player;
}

async function enqueue({ guildId, textChannel, voiceChannel, userId, query }) {
  const finalQuery = await resolveQuery(query);
  if (!finalQuery) return false;

  const player = await getOrCreatePlayer({ guildId, textChannel, voiceChannel, userId });
  // Some ZiPlayer versions return undefined on success. Only an explicit false
  // is considered a failed result; thrown errors are handled by the caller.
  const result = await player.play(finalQuery, userId);
  return result !== false;
}

async function clearControls(player) {
  const userdata = player?.userdata;
  const message = userdata?.controlMessage;
  if (!message) return;

  await message.edit({ components: [] }).catch(() => {});
  userdata.controlMessage = null;
}

async function stopAndLeave(player) {
  if (!player) return;
  const userdata = ensureUserdata(player);
  // Prevent stop-triggered queueEnd events from claiming the queue finished normally.
  userdata.suppressQueueEnd = true;
  await clearControls(player);

  try {
    if (typeof player.queue?.clear === "function") player.queue.clear();
    if (typeof player.stop === "function") await player.stop();
  } finally {
    if (typeof player.destroy === "function") await player.destroy();
  }
}

async function skipToPosition(player, position) {
  const tracks = getAllQueueTracks(player);
  if (!Number.isInteger(position) || position < 1 || position > tracks.length) return false;
  if (typeof player.queue?.remove !== "function" || typeof player.skip !== "function") return false;
  if (!getCurrentTrack(player)) return false;

  // Queue positions are 1-based in the UI. Remove tracks before the target,
  // then skip the current track so the selected item becomes the next one.
  for (let index = 1; index < position; index += 1) {
    player.queue.remove(0);
  }
  await player.skip();
  return true;
}

// --------------------------- Queue UI ---------------------------

function createMusicControls() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_pause")
      .setLabel("⏯ Tạm dừng / Tiếp tục")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music_skip")
      .setLabel("⏭ Bỏ qua")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("music_queue")
      .setLabel("📜 Hàng chờ")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("music_stop")
      .setLabel("⏹ Dừng")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildNowPlayingEmbed(player, track = getCurrentTrack(player)) {
  if (!track) {
    return new EmbedBuilder()
      .setColor("#2b2d31")
      .setTitle("🎵 Hiện không có bài hát nào đang phát.");
  }

  const url = safeHttpUrl(track.url);
  const description = [
    `**${escapeMarkdown(clipText(track.title))}**`,
    url ? `<${url}>` : null,
  ].filter(Boolean).join("\n");

  const embed = new EmbedBuilder()
    .setColor("#5865F2")
    .setTitle("🎵 Đang phát")
    .setDescription(description)
    .addFields(
      { name: "⏱️ Thời lượng", value: formatDuration(track.duration), inline: true },
      { name: "🔊 Âm lượng", value: `${player.volume ?? 80}%`, inline: true },
      {
        name: "👤 Yêu cầu bởi",
        value: resolveUserMention(track.requestedBy, player.userdata?.lastRequesterId),
        inline: true,
      },
    )
    .setFooter({ text: "Nexora Music VIP" });

  const thumbnail = safeHttpUrl(track.thumbnail);
  if (thumbnail) embed.setThumbnail(thumbnail);
  return embed;
}

function buildQueuePage(player, page = 1, pageSize = QUEUE_PAGE_SIZE) {
  const tracks = getAllQueueTracks(player);
  const totalPages = Math.max(1, Math.ceil(tracks.length / pageSize));
  const currentPage = Math.max(1, Math.min(Math.floor(Number(page) || 1), totalPages));
  const startIndex = (currentPage - 1) * pageSize;
  const pageTracks = tracks.slice(startIndex, startIndex + pageSize);
  const current = getCurrentTrack(player);

  let description = current
    ? `**Đang phát:** ${escapeMarkdown(clipText(current.title, 220))}\n\n`
    : "**Đang phát:** Không có\n\n";

  if (pageTracks.length === 0) {
    description += "*Hàng chờ trống.*";
  } else {
    for (let index = 0; index < pageTracks.length; index += 1) {
      const track = pageTracks[index];
      const queuePosition = startIndex + index + 1;
      const title = escapeMarkdown(clipText(track.title, 180));
      const url = safeHttpUrl(track.url);
      description += `${queuePosition}. \`${formatDuration(track.duration)}\` ${title}`;
      if (url) description += ` — <${url}>`;
      description += "\n";
    }
  }

  const embed = new EmbedBuilder()
    .setColor("#2b2d31")
    .setTitle(`📜 Hàng chờ · Trang ${currentPage}/${totalPages}`)
    .setDescription(description.slice(0, 4000))
    .setFooter({ text: `${tracks.length} bài trong hàng chờ · Chọn bài để phát tiếp theo` });

  const navigationButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q_first_${currentPage}`)
      .setLabel("≪")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 1),
    new ButtonBuilder()
      .setCustomId(`q_prev_${currentPage}`)
      .setLabel("‹")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === 1),
    new ButtonBuilder()
      .setCustomId(`q_next_${currentPage}`)
      .setLabel("›")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === totalPages),
    new ButtonBuilder()
      .setCustomId(`q_last_${currentPage}`)
      .setLabel("≫")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === totalPages),
  );

  const components = [navigationButtons];

  if (pageTracks.length > 0) {
    const trackMenu = new StringSelectMenuBuilder()
      .setCustomId("q_play_track_menu")
      .setPlaceholder("🎵 Chọn bài muốn phát tiếp theo")
      .addOptions(
        pageTracks.map((track, index) => {
          const position = startIndex + index + 1;
          const labelTitle = clipText(track.title, 85);
          return new StringSelectMenuOptionBuilder()
            .setLabel(clipText(`${position}. ${labelTitle}`, 100))
            .setValue(`trackpos_${position}`)
            .setDescription(`Thời lượng: ${formatDuration(track.duration)}`);
        }),
      );
    components.push(new ActionRowBuilder().addComponents(trackMenu));
  }

  // A Discord select menu can contain at most 25 options. Center the visible
  // window around the current page so long queues remain navigable.
  if (totalPages > 1) {
    const firstVisiblePage = Math.max(1, Math.min(currentPage - 12, totalPages - 24));
    const lastVisiblePage = Math.min(totalPages, firstVisiblePage + 24);
    const pageOptions = [];

    for (let pageNumber = firstVisiblePage; pageNumber <= lastVisiblePage; pageNumber += 1) {
      pageOptions.push(
        new StringSelectMenuOptionBuilder()
          .setLabel(`Trang ${pageNumber}`)
          .setValue(`page_${pageNumber}`)
          .setDefault(pageNumber === currentPage),
      );
    }

    const pageMenu = new StringSelectMenuBuilder()
      .setCustomId("q_jump_menu")
      .setPlaceholder("Chuyển nhanh đến trang…")
      .addOptions(pageOptions);
    components.push(new ActionRowBuilder().addComponents(pageMenu));
  }

  return { embeds: [embed], components };
}

// --------------------------- ZiPlayer events ---------------------------

manager.on("trackStart", async (player, track) => {
  const channel = player?.userdata?.channel;
  if (!channel?.send) return;

  try {
    await clearControls(player);
    const embed = buildNowPlayingEmbed(player, track);
    const message = await channel.send({ embeds: [embed], components: [createMusicControls()] });
    ensureUserdata(player).controlMessage = message;
    ensureUserdata(player).paused = false;
  } catch (error) {
    console.error("[trackStart error]", error);
  }
});

manager.on("queueEnd", async (player) => {
  if (player?.userdata?.suppressQueueEnd) return;
  await clearControls(player);
  const channel = player?.userdata?.channel;
  if (channel?.send) {
    await channel.send("✅ Đã phát xong danh sách chờ!").catch(() => {});
  }
});

manager.on("playerPause", (player) => {
  ensureUserdata(player).paused = true;
});

manager.on("playerResume", (player) => {
  ensureUserdata(player).paused = false;
});

manager.on("playerError", (player, error, track) => {
  console.error("[ZiPlayer error]", error);
  const channel = player?.userdata?.channel;
  if (channel?.send) {
    const title = track?.title ? ` (${clipText(track.title, 80)})` : "";
    channel.send(`⚠️ Có lỗi khi phát nhạc${title}. Hãy thử lại hoặc chọn bài khác.`).catch(() => {});
  }
});

// --------------------------- Prefix commands ---------------------------

async function handlePrefixCommand(message) {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = (args.shift() || "").toLowerCase();
  if (!command) return;

  const voiceChannel = message.member?.voice?.channel;

  try {
    if (["play", "p"].includes(command)) {
      if (!voiceChannel) return message.reply("❌ Bạn cần vào kênh thoại trước khi phát nhạc.");
      const query = args.join(" ").trim();
      if (!query) return message.reply(`❌ Cách dùng: \`${PREFIX}play tên bài hát hoặc link\``);

      const ok = await enqueue({
        guildId: message.guild.id,
        textChannel: message.channel,
        voiceChannel,
        userId: message.author.id,
        query,
      });
      return message.reply(ok ? "🔍 Đã thêm yêu cầu vào trình phát!" : "❌ Không tìm thấy bài hát phù hợp.");
    }

    if (["queue", "q"].includes(command)) {
      const player = getPlayerForGuild(message.guild.id);
      if (!player) return message.reply("🎶 Hàng chờ đang trống.");
      return message.reply(buildQueuePage(player, 1));
    }

    if (["nowplaying", "np"].includes(command)) {
      const player = getPlayerForGuild(message.guild.id);
      if (!player || !getCurrentTrack(player)) return message.reply("🎶 Hiện không có bài hát nào đang phát.");
      return message.reply({ embeds: [buildNowPlayingEmbed(player)] });
    }

    if (["skip", "s"].includes(command)) {
      const player = getPlayerForGuild(message.guild.id);
      if (!player || !getCurrentTrack(player)) return message.reply("❌ Không có bài hát đang phát.");
      if (!(await requireSameVoiceForMessage(message, player))) return;
      await player.skip();
      return message.reply("⏭️ Đã chuyển bài!");
    }

    if (command === "skipto") {
      const player = getPlayerForGuild(message.guild.id);
      if (!player || !getCurrentTrack(player)) return message.reply("❌ Hàng chờ đang trống.");
      if (!(await requireSameVoiceForMessage(message, player))) return;
      const position = Number.parseInt(args[0], 10);
      if (!Number.isInteger(position) || position < 1) return message.reply("❌ Vui lòng nhập số thứ tự hợp lệ.");
      const success = await skipToPosition(player, position);
      if (!success) return message.reply("❌ Vị trí không tồn tại trong hàng chờ.");
      return message.reply(`⏩ Đã chuyển đến bài số **${position}** trong hàng chờ.`);
    }

    if (command === "shuffle") {
      const player = getPlayerForGuild(message.guild.id);
      if (!player || getAllQueueTracks(player).length < 2) return message.reply("❌ Cần ít nhất 2 bài trong hàng chờ để trộn.");
      if (!(await requireSameVoiceForMessage(message, player))) return;
      if (typeof player.shuffle === "function") await player.shuffle();
      else if (typeof player.queue?.shuffle === "function") await player.queue.shuffle();
      else return message.reply("❌ Trình phát hiện không hỗ trợ trộn hàng chờ.");
      return message.reply("🔀 Đã trộn hàng chờ!");
    }

    if (command === "stop") {
      const player = getPlayerForGuild(message.guild.id);
      if (!player) return message.reply("❌ Bot hiện không phát nhạc.");
      if (!(await requireSameVoiceForMessage(message, player))) return;
      await stopAndLeave(player);
      return message.reply("⏹️ Đã dừng nhạc và rời kênh thoại.");
    }

    if (["admin", "stats", "clear", "leave"].includes(command)) {
      if (!isAdmin(message.author.id)) {
        return message.reply("⛔ Bạn không có quyền sử dụng lệnh Admin.");
      }

      const subcommand = command === "admin" ? (args[0] || "").toLowerCase() : command;
      if (subcommand === "stats") {
        const memory = process.memoryUsage();
        const formatMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        const stats = typeof manager.getStats === "function" ? manager.getStats() : {};
        const uptime = Math.floor(process.uptime());
        const embed = new EmbedBuilder()
          .setColor("#FFD700")
          .setTitle("📊 Thông số NEXORA MUSIC VIP")
          .addFields(
            { name: "RAM tiến trình (RSS)", value: formatMb(memory.rss), inline: true },
            { name: "Heap đang dùng", value: formatMb(memory.heapUsed), inline: true },
            { name: "Uptime", value: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`, inline: true },
            { name: "Node.js", value: process.version, inline: true },
            { name: "Discord servers", value: String(client.guilds.cache.size), inline: true },
            { name: "Player đang quản lý", value: String(stats?.totalPlayers ?? "N/A"), inline: true },
          );
        return message.reply({ embeds: [embed] });
      }

      if (["clearqueue", "clear"].includes(subcommand)) {
        const player = getPlayerForGuild(message.guild.id);
        if (!player) return message.reply("❌ Bot không có trình phát trong máy chủ này.");
        if (typeof player.queue?.clear === "function") player.queue.clear();
        return message.reply("🧹 Đã xóa toàn bộ hàng chờ. Bài đang phát (nếu có) sẽ không bị dừng.");
      }

      if (["forceleave", "leave"].includes(subcommand)) {
        const player = getPlayerForGuild(message.guild.id);
        if (!player) return message.reply("❌ Bot hiện không ở trong kênh thoại.");
        await stopAndLeave(player);
        return message.reply("🛑 [ADMIN] Đã buộc bot dừng và rời kênh thoại.");
      }
    }
  } catch (error) {
    console.error(`[Prefix command error: ${command}]`, error);
    await message.reply(getSafeErrorMessage(error)).catch(() => {});
  }
}

client.on("messageCreate", handlePrefixCommand);

// --------------------------- Slash interactions ---------------------------

async function handleSlashCommand(interaction) {
  const { commandName } = interaction;
  const voiceChannel = interaction.member?.voice?.channel;

  if (commandName === "play") {
    if (!voiceChannel) {
      return interaction.reply({ content: "❌ Bạn cần vào kênh thoại trước khi phát nhạc.", flags: EPHEMERAL });
    }

    await interaction.deferReply();
    const ok = await enqueue({
      guildId: interaction.guildId,
      textChannel: interaction.channel,
      voiceChannel,
      userId: interaction.user.id,
      query: interaction.options.getString("query", true),
    });
    return interaction.editReply(ok ? "🔍 Đã thêm yêu cầu vào trình phát!" : "❌ Không tìm thấy bài hát phù hợp.");
  }

  if (commandName === "queue") {
    const player = getPlayerForGuild(interaction.guildId);
    if (!player) return interaction.reply({ content: "🎶 Hàng chờ đang trống.", flags: EPHEMERAL });
    return interaction.reply({ ...buildQueuePage(player, 1), flags: EPHEMERAL });
  }

  if (commandName === "nowplaying") {
    const player = getPlayerForGuild(interaction.guildId);
    if (!player || !getCurrentTrack(player)) {
      return interaction.reply({ content: "🎶 Hiện không có bài hát nào đang phát.", flags: EPHEMERAL });
    }
    return interaction.reply({ embeds: [buildNowPlayingEmbed(player)], flags: EPHEMERAL });
  }

  if (commandName === "skip") {
    const player = getPlayerForGuild(interaction.guildId);
    if (!player || !getCurrentTrack(player)) {
      return interaction.reply({ content: "❌ Không có bài hát đang phát.", flags: EPHEMERAL });
    }
    if (!(await requireSameVoiceForInteraction(interaction, player))) return;
    await player.skip();
    return interaction.reply({ content: "⏭️ Đã chuyển bài!", flags: EPHEMERAL });
  }

  if (commandName === "skipto") {
    const player = getPlayerForGuild(interaction.guildId);
    if (!player || !getCurrentTrack(player)) {
      return interaction.reply({ content: "❌ Hàng chờ đang trống.", flags: EPHEMERAL });
    }
    if (!(await requireSameVoiceForInteraction(interaction, player))) return;
    const position = interaction.options.getInteger("position", true);
    const success = await skipToPosition(player, position);
    if (!success) {
      return interaction.reply({ content: "❌ Vị trí không tồn tại trong hàng chờ.", flags: EPHEMERAL });
    }
    return interaction.reply({ content: `⏩ Đã chuyển đến bài số **${position}** trong hàng chờ.`, flags: EPHEMERAL });
  }

  if (commandName === "shuffle") {
    const player = getPlayerForGuild(interaction.guildId);
    if (!player || getAllQueueTracks(player).length < 2) {
      return interaction.reply({ content: "❌ Cần ít nhất 2 bài trong hàng chờ để trộn.", flags: EPHEMERAL });
    }
    if (!(await requireSameVoiceForInteraction(interaction, player))) return;
    if (typeof player.shuffle === "function") await player.shuffle();
    else if (typeof player.queue?.shuffle === "function") await player.queue.shuffle();
    else return interaction.reply({ content: "❌ Trình phát hiện không hỗ trợ trộn hàng chờ.", flags: EPHEMERAL });
    return interaction.reply({ content: "🔀 Đã trộn hàng chờ!", flags: EPHEMERAL });
  }

  if (commandName === "stop") {
    const player = getPlayerForGuild(interaction.guildId);
    if (!player) return interaction.reply({ content: "❌ Bot hiện không phát nhạc.", flags: EPHEMERAL });
    if (!(await requireSameVoiceForInteraction(interaction, player))) return;
    await stopAndLeave(player);
    return interaction.reply({ content: "⏹️ Đã dừng nhạc và rời kênh thoại.", flags: EPHEMERAL });
  }

  if (commandName === "admin") {
    if (!isAdmin(interaction.user.id)) {
      return interaction.reply({ content: "⛔ Bạn không có quyền Admin.", flags: EPHEMERAL });
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "stats") {
      const memory = process.memoryUsage();
      const formatMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
      const stats = typeof manager.getStats === "function" ? manager.getStats() : {};
      const uptime = Math.floor(process.uptime());
      const embed = new EmbedBuilder()
        .setColor("#FFD700")
        .setTitle("📊 Thông số NEXORA MUSIC VIP")
        .addFields(
          { name: "RAM tiến trình (RSS)", value: formatMb(memory.rss), inline: true },
          { name: "Heap đang dùng", value: formatMb(memory.heapUsed), inline: true },
          { name: "Uptime", value: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`, inline: true },
          { name: "Node.js", value: process.version, inline: true },
          { name: "Discord servers", value: String(client.guilds.cache.size), inline: true },
          { name: "Player đang quản lý", value: String(stats?.totalPlayers ?? "N/A"), inline: true },
        );
      return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
    }

    if (subcommand === "clearqueue") {
      const player = getPlayerForGuild(interaction.guildId);
      if (!player) return interaction.reply({ content: "❌ Không có trình phát trong máy chủ này.", flags: EPHEMERAL });
      if (typeof player.queue?.clear === "function") player.queue.clear();
      return interaction.reply({ content: "🧹 Đã xóa toàn bộ hàng chờ. Bài đang phát (nếu có) sẽ không bị dừng.", flags: EPHEMERAL });
    }

    if (subcommand === "forceleave") {
      const player = getPlayerForGuild(interaction.guildId);
      if (!player) return interaction.reply({ content: "❌ Bot hiện không ở trong kênh thoại.", flags: EPHEMERAL });
      await stopAndLeave(player);
      return interaction.reply({ content: "🛑 Đã buộc bot dừng và rời kênh thoại.", flags: EPHEMERAL });
    }
  }
}

async function handleComponentInteraction(interaction) {
  const isButton = interaction.isButton();
  const isSelectMenu = interaction.isStringSelectMenu();
  if (!isButton && !isSelectMenu) return;

  const customId = interaction.customId;
  if (!customId.startsWith("q_") && !customId.startsWith("music_")) return;

  const player = getPlayerForGuild(interaction.guildId);
  if (!player) {
    return interaction.reply({ content: "❌ Bot hiện không có trình phát trong máy chủ này.", flags: EPHEMERAL });
  }

  if (isSelectMenu && customId === "q_play_track_menu") {
    if (!(await requireSameVoiceForInteraction(interaction, player))) return;
    const targetPosition = Number.parseInt(interaction.values[0]?.split("_")[1], 10);
    await interaction.deferReply({ flags: EPHEMERAL });
    const success = await skipToPosition(player, targetPosition);
    return interaction.editReply(
      success
        ? `⏩ Đã chọn bài số **${targetPosition}** để phát tiếp theo.`
        : "❌ Vị trí không còn tồn tại trong hàng chờ. Hãy mở lại hàng chờ rồi chọn lại.",
    );
  }

  if (isSelectMenu && customId === "q_jump_menu") {
    const targetPage = Number.parseInt(interaction.values[0]?.split("_")[1], 10) || 1;
    return interaction.update(buildQueuePage(player, targetPage));
  }

  if (isButton && customId.startsWith("q_")) {
    const [, action, pageText] = customId.split("_");
    let page = Number.parseInt(pageText, 10) || 1;
    const totalPages = Math.max(1, Math.ceil(getAllQueueTracks(player).length / QUEUE_PAGE_SIZE));

    if (action === "first") page = 1;
    else if (action === "prev") page = Math.max(1, page - 1);
    else if (action === "next") page = Math.min(totalPages, page + 1);
    else if (action === "last") page = totalPages;
    else return;

    return interaction.update(buildQueuePage(player, page));
  }

  if (isButton && customId.startsWith("music_")) {
    if (customId === "music_queue") {
      return interaction.reply({ ...buildQueuePage(player, 1), flags: EPHEMERAL });
    }

    if (!["music_pause", "music_skip", "music_stop"].includes(customId)) return;
    if (!(await requireSameVoiceForInteraction(interaction, player))) return;
    if (customId !== "music_stop" && !getCurrentTrack(player)) {
      return interaction.reply({ content: "❌ Hiện không có bài hát đang phát.", flags: EPHEMERAL });
    }

    await interaction.deferUpdate();
    const userdata = ensureUserdata(player);

    if (customId === "music_pause") {
      if (userdata.paused) {
        await player.resume();
        userdata.paused = false;
      } else {
        await player.pause();
        userdata.paused = true;
      }
    } else if (customId === "music_skip") {
      await player.skip();
    } else if (customId === "music_stop") {
      await stopAndLeave(player);
    }
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.inGuild()) return;

  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return;
    }
    await handleComponentInteraction(interaction);
  } catch (error) {
    console.error("[Interaction error]", error);
    await sendInteractionError(interaction, getSafeErrorMessage(error));
  }
});

// --------------------------- Startup ---------------------------

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ NEXORA MUSIC VIP ready: ${readyClient.user.tag}`);

  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commands });
    console.log("🚀 Slash commands registered.");
  } catch (error) {
    console.error("❌ Could not register slash commands:", error);
  }
});

client.on("error", (error) => {
  console.error("[Discord client error]", error);
});

if (!TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN. Add it to your hosting environment or .env file.");
  process.exitCode = 1;
  if (webServer.listening) webServer.close();
  else webServer.once("listening", () => webServer.close());
} else {
  client.login(TOKEN).catch((error) => {
    console.error("❌ Discord login failed:", error);
    process.exitCode = 1;
    client.destroy();
    webServer.close();
  });
}
