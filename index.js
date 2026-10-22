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
    if (typeof v === "string") return `<@${v}>`; if (typeof v === "object") { const id = v.id \vert{}\vert{} v.userId \vert{}\vert{} v.user?.id; if (id) return `<@${id}>`;
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
    new ButtonBuilder().setCustomId(`q_prev_${currentPage}`).setLabel("<").setStyle(ButtonStyle.Primary).setDisabled(currentPage === 1), new ButtonBuilder().setCustomId(`q_next_${currentPage}`).setLabel(">").setStyle(ButtonStyle.Primary).setDisabled(currentPage === totalPages),
    new ButtonBuilder().setCustomId(`q_last_${currentPage}`).setLabel(">>").setStyle(ButtonStyle.Secondary).setDisabled(currentPage === totalPages) );  const componentsArray = [buttons];  // 2. Menu chọn bài hát phát ngay if (pageTracks.length > 0) { const trackSelectMenu = new StringSelectMenuBuilder() .setCustomId("q_play_track_menu") .setPlaceholder("🎵 Chọn phát ngay 1 bài trong trang này...");  const trackOptions = pageTracks.map((t, i) => { const realIndex = startIdx + i + 1; const titleShort = t.title.length > 50 ? t.title.substring(0, 47) + "..." : t.title; return new StringSelectMenuOptionBuilder() .setLabel(`${realIndex}. ${titleShort}`) .setValue(`trackpos_${realIndex}`)
        .setDescription(`Thời lượng: ${formatDuration(t.duration)}`); });  trackSelectMenu.addOptions(trackOptions); componentsArray.push(new ActionRowBuilder().addComponents(trackSelectMenu)); }  // 3. Menu chọn trang nhanh if (totalPages > 1) { const pageSelectMenu = new StringSelectMenuBuilder() .setCustomId("q_jump_menu") .setPlaceholder("Đưa ra lựa chọn");  const pageOptions = []; for (let i = 1; i <= Math.min(25, totalPages); i++) { pageOptions.push( new StringSelectMenuOptionBuilder() .setLabel(`Trang ${i}`)
          .setValue(`page
