import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
import "dotenv/config";

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
});

const manager = getManager();
const PREFIX = process.env.PREFIX || "!";
const EPHEMERAL = MessageFlags.Ephemeral;

const ADMIN_USER_IDS = ["1073520375285166100"]; 

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Phát nhạc từ YouTube, Spotify, SoundCloud hoặc tên bài hát")
    .addStringOption((option) =>
      option.setName("query").setDescription("Tên bài hát hoặc đường dẫn URL").setRequired(true)
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Bỏ qua bài hát hiện tại"),
  new SlashCommandBuilder().setName("queue").setDescription("Xem danh sách hàng chờ phát nhạc"),
  new SlashCommandBuilder().setName("stop").setDescription("Dừng nhạc và rời phòng thoại"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Xem thông tin chi tiết bài đang phát"),
  new SlashCommandBuilder().setName("shuffle").setDescription("Trộn ngẫu nhiên danh sách hàng chờ"),
  
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Thay đổi âm lượng phát nhạc")
    .addIntegerOption((option) =>
      option.setName("level").setDescription("Độ lớn âm lượng (1 - 100)").setRequired(true).setMinValue(1).setMaxValue(100)
    ),

  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Cài đặt chế độ lặp lại phát nhạc")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Chọn kiểu lặp lại")
        .setRequired(true)
        .addChoices(
          { name: "🔂 Bài hát hiện tại", value: "track" },
          { name: "🔁 Toàn bộ hàng chờ", value: "queue" },
          { name: "➡️ Tắt lặp", value: "off" }
        )
    ),

  new SlashCommandBuilder()
    .setName("filter")
    .setDescription("Chỉnh hiệu ứng âm thanh (Audio Filter)")
    .addStringOption((option) =>
      option
        .setName("preset")
        .setDescription("Chọn hiệu ứng âm thanh")
        .setRequired(true)
        .addChoices(
          { name: "🔊 Bassboost (Tăng trầm)", value: "bassboost" },
          { name: "⚡ Nightcore (Nhanh & Tông cao)", value: "nightcore" },
          { name: "🎧 8D (Xoay vòm 360)", value: "8d" },
          { name: "❌ Tắt hiệu ứng (Clear)", value: "clear" }
        )
    ),

  new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Hệ thống quản trị dành riêng cho Admin Bot")
    .addSubcommand((s) => s.setName("stats").setDescription("Trạng thái tài nguyên máy chủ bot"))
    .addSubcommand((s) => s.setName("clearqueue").setDescription("Xóa sạch hàng chờ phát nhạc"))
    .addSubcommand((s) => s.setName("forceleave").setDescription("Buộc bot ngắt kết nối kênh thoại")),
].map((cmd) => cmd.toJSON());

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

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

function getUpcomingTracks(player, limit = 10) {
  const q = player.queue;
  if (!q) return [];
  let list = [];
  if (typeof q.toArray === "function") list = q.toArray();
  else if (Array.isArray(q.tracks)) list = q.tracks;
  else if (typeof q.getTrack === "function") {
    for (let i = 0; i < (q.size || 0); i++) {
      const t = q.getTrack(i);
      if (t) list.push(t);
    }
  }
  const current = player.currentTrack;
  return list.filter((t) => t !== current).slice(0, limit);
}

function buildQueueEmbed(player) {
  const current = player.currentTrack;
  const upcoming = getUpcomingTracks(player);
  let desc = `**Đang phát:** ${current ? current.title : "Không có"}\n\n**Tiếp theo:**\n`;
  if (upcoming.length === 0) {
    desc += "*Không có bài hát tiếp theo trong hàng chờ.*";
  } else {
    upcoming.forEach((t, i) => {
      desc += `\`${i + 1}.\` ${t.title} (${resolveUserMention(t.requestedBy)})\n`;
    });
  }
  return new EmbedBuilder().setColor("#1E90FF").setTitle("📜 Hàng Chờ Phát Nhạc").setDescription(desc);
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

function inBotVoice(guild, member) {
  const userChannelId = member?.voice?.channelId;
  if (!userChannelId) return false;
  const botChannelId = guild.members.me?.voice?.channelId;
  return !botChannelId || botChannelId === userChannelId;
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
  const player = await getOrCreatePlayer(guildId, textChannel, userId);
  if (!player.connection) await player.connect(voiceChannel);
  return player.play(query, userId);
}

async function stopAndLeave(player) {
  await clearControls(player);
  await player.stop();
  await player.destroy();
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
      .setFooter({ text: "Nexora Music • Hệ thống âm thanh chuyên nghiệp" });

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
  player.metadata?.channel?.send("✅ Đã phát xong danh sách chờ. Bot tạm nghỉ!").catch(() => {});
});

manager.on("playerError", (player, error) => {
  console.error(`[Error Guild ${player.id}]:`, error);
  player.metadata?.channel?.send(`⚠️ Lỗi nhạc: ${error?.message || error}`).catch(() => {});
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/g);
  const command = args.shift()?.toLowerCase();
  const voiceChannel = message.member?.voice?.channel;

  try {
    if (command === "play" || command === "p") {
      if (!voiceChannel) return message.reply("❌ Bạn phải vào một kênh thoại trước!");
      const query = args.join(" ");
      if (!query && message.attachments.size === 0) return message.reply("❌ Vui lòng nhập tên bài hát hoặc link!");

      const ok = await enqueue({
        guildId: message.guild.id,
        textChannel: message.channel,
        voiceChannel,
        userId: message.author.id,
        query: message.attachments.first()?.url || query,
      });
      if (!ok) return message.reply("❌ Không tìm thấy kết quả hợp lệ.");
      return message.reply(`🔍 Đã thêm bài hát vào hàng chờ bởi <@${message.author.id}>!`);
    }

    if (command === "skip" || command === "s") {
      const player = getPlayer(message.guild.id);
      if (!player || !player.currentTrack) return message.reply("❌ Không có bài hát nào đang phát!");
      if (!inBotVoice(message.guild, message.member)) return message.reply("❌ Bạn phải vào chung phòng với bot!");
      await player.skip();
      return message.reply("⏭️ Đã chuyển bài!");
    }

    if (command === "stop") {
      const player = getPlayer(message.guild.id);
      if (!player) return message.reply("❌ Bot không trong kênh thoại!");
      if (!inBotVoice(message.guild, message.member)) return message.reply("❌ Bạn phải vào chung phòng với bot!");
      await stopAndLeave(player);
      return message.reply("⏹️ Đã dừng nhạc và rời phòng.");
    }

    if (command === "queue" || command === "q") {
      const player = getPlayer(message.guild.id);
      if (!player || !player.currentTrack) return message.reply("🎶 Hàng chờ đang trống.");
      return message.reply({ embeds: [buildQueueEmbed(player)] });
    }

    if (command === "volume" || command === "vol") {
      const player = getPlayer(message.guild.id);
      if (!player) return message.reply("❌ Bot chưa kết nối.");
      const vol = parseInt(args[0]);
      if (isNaN(vol) || vol < 1 || vol > 100) return message.reply("❌ Vui lòng nhập số từ 1 đến 100.");
      player.setVolume(vol);
      return message.reply(`🔊 Đã chỉnh âm lượng thành **${vol}%**`);
    }

    if (command === "admin") {
      if (!isAdmin(message.author.id)) return message.reply("❌ Bạn không phải Admin của Bot!");
      const sub = args.shift()?.toLowerCase();
      if (sub === "stats") {
        const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
        return message.reply(`📊 **RAM sử dụng:** ${memoryUsage} MB | **Servers:** ${client.guilds.cache.size}`);
      }
      if (sub === "clearqueue") {
        const player = getPlayer(message.guild.id);
        if (player?.queue) player.queue.clear();
        return message.reply("🧹 [Admin] Đã dọn sạch hàng chờ.");
      }
      if (sub === "forceleave") {
        const player = getPlayer(message.guild.id);
        if (player) await stopAndLeave(player);
        return message.reply("⚡ [Admin] Đã ngắt kết nối bot.");
      }
    }
  } catch (err) {
    console.error(`[prefix:${command}]`, err);
  }
});

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
        return interaction.editReply(`🔍 Đã thêm bài hát vào hàng chờ bởi <@${interaction.user.id}>!`);
      }

      if (commandName === "skip") {
        const player = getPlayer(interaction.guildId);
        if (!player || !player.currentTrack) return interaction.reply({ content: "❌ Không có bài hát nào đang phát!", flags: EPHEMERAL });
        await player.skip();
        return interaction.reply("⏭️ Đã chuyển bài!");
      }

      if (commandName === "stop") {
        const player = getPlayer(interaction.guildId);
        if (!player) return interaction.reply({ content: "❌ Bot không trong kênh thoại!", flags: EPHEMERAL });
        await stopAndLeave(player);
        return interaction.reply("⏹️ Đã dừng nhạc và rời phòng.");
      }

      if (commandName === "queue") {
        const player = getPlayer(interaction.guildId);
        if (!player || !player.currentTrack) return interaction.reply({ content: "🎶 Hàng chờ đang trống.", flags: EPHEMERAL });
        return interaction.reply({ embeds: [buildQueueEmbed(player)], flags: EPHEMERAL });
      }

      if (commandName === "nowplaying") {
        const player = getPlayer(interaction.guildId);
        if (!player || !player.currentTrack) return interaction.reply({ content: "❌ Không có bài hát nào đang phát!", flags: EPHEMERAL });
        const track = player.currentTrack;
        const embed = new EmbedBuilder()
          .setColor("#1E90FF")
          .setTitle("🎧 Đang Phát Hiện Tại")
          .setDescription(`[**${track.title}**](${track.url})`)
          .addFields(
            { name: "⏱️ Thời lượng", value: formatDuration(track.duration), inline: true },
            { name: "🔊 Âm lượng", value: `${player.volume || 80}%`, inline: true }
          )
          .setThumbnail(track.thumbnail || null);
        return interaction.reply({ embeds: [embed] });
      }

      if (commandName === "volume") {
        const player = getPlayer(interaction.guildId);
        if (!player) return interaction.reply({ content: "❌ Bot chưa kết nối phòng thoại!", flags: EPHEMERAL });
        const level = interaction.options.getInteger("level", true);
        player.setVolume(level);
        return interaction.reply(`🔊 Đã chỉnh âm lượng lên **${level}%**`);
      }

      if (commandName === "shuffle") {
        const player = getPlayer(interaction.guildId);
        if (!player || !player.queue) return interaction.reply({ content: "❌ Hàng chờ trống!", flags: EPHEMERAL });
        if (typeof player.queue.shuffle === "function") player.queue.shuffle();
        return interaction.reply("🔀 Đã xáo trộn ngẫu nhiên danh sách hàng chờ!");
      }

      if (commandName === "loop") {
        const player = getPlayer(interaction.guildId);
        if (!player) return interaction.reply({ content: "❌ Bot chưa phát nhạc!", flags: EPHEMERAL });
        const mode = interaction.options.getString("mode", true);
        if (typeof player.setLoop === "function") player.setLoop(mode);
        return interaction.reply(`🔁 Đã chuyển chế độ lặp lại sang: **${mode.toUpperCase()}**`);
      }

      if (commandName === "filter") {
        const player = getPlayer(interaction.guildId);
        if (!player) return interaction.reply({ content: "❌ Bot chưa phát nhạc!", flags: EPHEMERAL });
        const preset = interaction.options.getString("preset", true);
        if (typeof player.setFilter === "function") player.setFilter(preset === "clear" ? null : preset);
        return interaction.reply(`🎛️ Đã áp dụng hiệu ứng âm thanh: **${preset.toUpperCase()}**`);
      }

      if (commandName === "admin") {
        if (!isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ Quyền truy cập bị từ chối! Lệnh này chỉ dành cho Chủ sở hữu Bot.", flags: EPHEMERAL });
        const sub = interaction.options.getSubcommand();
        if (sub === "stats") {
          const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
          return interaction.reply({ content: `📊 **RAM:** ${memoryUsage} MB | **Servers:** ${client.guilds.cache.size}`, flags: EPHEMERAL });
        }
        if (sub === "clearqueue") {
          const player = getPlayer(interaction.guildId);
          if (player?.queue) player.queue.clear();
          return interaction.reply({ content: "🧹 [Admin] Đã xóa sạch hàng chờ.", flags: EPHEMERAL });
        }
        if (sub === "forceleave") {
          const player = getPlayer(interaction.guildId);
          if (player) await stopAndLeave(player);
          return interaction.reply({ content: "⚡ [Admin] Đã buộc bot rời phòng.", flags: EPHEMERAL });
        }
      }
    } catch (err) {
      console.error(`[slash:${commandName}]`, err);
    }
    return;
  }

  if (interaction.isButton()) {
    if (!interaction.customId.startsWith("music_")) return;
    const player = getPlayer(interaction.guildId);
    if (!player) return interaction.reply({ content: "❌ Bot không trong kênh thoại!", flags: EPHEMERAL });

    try {
      if (interaction.customId === "music_queue") {
        return interaction.reply({ embeds: [buildQueueEmbed(player)], flags: EPHEMERAL });
      }

      await interaction.deferUpdate().catch(() => {});

      if (interaction.customId === "music_pause") {
        if (!player.pause()) player.resume();
      } else if (interaction.customId === "music_skip") {
        await player.skip();
      } else if (interaction.customId === "music_stop") {
        await stopAndLeave(player);
      }
    } catch (err) {
      console.error(`[button:${interaction.customId}]`, err);
    }
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot NEXORA MUSIC VIP đã sẵn sàng: ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log("🔄 Đang đồng bộ hóa toàn bộ Slash Commands cao cấp lên Discord...");
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("🚀 Đã đăng ký thành công danh sách lệnh cao cấp!");
  } catch (error) {
    console.error("❌ Lỗi khi đăng ký Slash Commands:", error);
  }
});

process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

client.login(process.env.DISCORD_TOKEN);
