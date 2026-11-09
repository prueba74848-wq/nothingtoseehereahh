(function () {
function require(id) {
  switch (id) {
    case "@vendetta": return vendetta;
    case "@vendetta/metro": return vendetta.metro;
    case "@vendetta/metro/common": return vendetta.metro.common;
    case "@vendetta/ui/toasts": return vendetta.ui.toasts;
    case "@vendetta/ui/assets": return vendetta.ui.assets;
    case "@vendetta/ui/components": return vendetta.ui.components;
    case "@vendetta/plugin": return vendetta.plugin;
    default: throw new Error("[AutoReadPings] Unknown module: " + id);
  }
}
var module = { exports: {} };
var exports = module.exports;

var plugin = require("@vendetta/plugin");
var metro = require("@vendetta/metro");
var common = require("@vendetta/metro/common");
var components = require("@vendetta/ui/components");
var toasts = require("@vendetta/ui/toasts");
var assets = require("@vendetta/ui/assets");

var React = common.React;
var RN = common.ReactNative;
var FluxDispatcher = common.FluxDispatcher || metro.findByProps("dispatch", "subscribe");
var Forms = components.Forms;
var TAG = "[AutoReadPings]";

var DEFAULTS = {
  everyone: true,
  here: true,
  direct: false,
  roles: [],
  delay: 500,
  scanOnLoad: true,
  clearUnknown: true,
  debug: true
};

function S() {
  var st = plugin.storage;
  for (var k in DEFAULTS) {
    if (st[k] === undefined) st[k] = Array.isArray(DEFAULTS[k]) ? [] : DEFAULTS[k];
  }
  return st;
}

function store(name) {
  try { return metro.findByStoreName(name); } catch (e) { return null; }
}

function myId() {
  try { return store("UserStore")?.getCurrentUser?.()?.id; } catch (e) { return null; }
}

function rolesOf(gid) {
  try {
    var r = store("GuildRoleStore")?.getRoles?.(gid);
    if (r && Object.keys(r).length) return r;
  } catch (e) {}
  try {
    var r2 = store("GuildStore")?.getRoles?.(gid);
    if (r2 && Object.keys(r2).length) return r2;
  } catch (e) {}
  try {
    return store("GuildStore")?.getGuild?.(gid)?.roles || {};
  } catch (e) {}
  return {};
}

function myRoleIds(gid) {
  var me = myId();
  var GMS = store("GuildMemberStore");
  var member = null;
  try { member = GMS?.getSelfMember?.(gid); } catch (e) {}
  if (!member) { try { member = GMS?.getMember?.(gid, me); } catch (e) {} }
  return (member && member.roles) || [];
}

function roleName(roleId) {
  try {
    var guilds = store("GuildStore").getGuilds();
    for (var gid in guilds) {
      var roles = rolesOf(gid);
      if (roles && roles[roleId]) return roles[roleId].name + " (" + guilds[gid].name + ")";
    }
  } catch (e) {}
  return "Unknown role";
}

// ---------- ping detection ----------
// Handles both raw gateway messages (snake_case) and cached Message objects (camelCase)
function isWatchedPing(msg, me) {
  var s = S();
  var content = msg.content || "";
  var mentionEveryone = msg.mention_everyone !== undefined ? msg.mention_everyone : msg.mentionEveryone;
  var mentionRoles = msg.mention_roles || msg.mentionRoles;

  if (mentionEveryone) {
    var hasEveryone = content.indexOf("@everyone") !== -1;
    var hasHere = content.indexOf("@here") !== -1;
    if (hasEveryone && s.everyone) return true;
    if (hasHere && s.here) return true;
    if (!hasEveryone && !hasHere && s.everyone) return true;
  }

  if (s.direct && me && Array.isArray(msg.mentions)) {
    for (var i = 0; i < msg.mentions.length; i++) {
      var m = msg.mentions[i];
      if ((m && m.id) === me || m === me) return true;
    }
  }

  if (mentionRoles && s.roles.length) {
    for (var j = 0; j < mentionRoles.length; j++) {
      if (s.roles.indexOf(mentionRoles[j]) !== -1) return true;
    }
  }
  return false;
}

// ---------- scan pings that arrived before the plugin / while it was off ----------
function mentionChannelIds() {
  var RS = store("ReadStateStore");
  if (!RS) return [];
  try {
    var ids = RS.getMentionChannelIds && RS.getMentionChannelIds();
    if (ids) return Array.from(ids);
  } catch (e) {}
  var out = [];
  try {
    var guilds = store("GuildStore").getGuilds();
    var CS = store("GuildChannelStore") || store("ChannelStore");
    for (var gid in guilds) {
      var data = CS && CS.getChannels && CS.getChannels(gid);
      var list = [].concat((data && data.SELECTABLE) || [], (data && data.VOCAL) || []);
      list.forEach(function (c) {
        var ch = (c && c.channel) || c;
        if (ch && ch.id && RS.getMentionCount && RS.getMentionCount(ch.id) > 0) out.push(ch.id);
      });
    }
  } catch (e) {}
  return out;
}

function cachedMessages(channelId) {
  try {
    var MS = store("MessageStore");
    var m = MS && MS.getMessages && MS.getMessages(channelId);
    if (!m) return [];
    if (m._array) return m._array;
    if (m.toArray) return m.toArray();
  } catch (e) {}
  return [];
}

function scanExisting() {
  var me = myId();
  var s = S();
  var CS = store("ChannelStore");
  var count = 0;
  var scanIds = mentionChannelIds();
  scanIds.forEach(function (id) {
    try {
      var ch = CS && CS.getChannel && CS.getChannel(id);
      if (!ch || !ch.guild_id) return; // servers only, never DMs
      var msgs = cachedMessages(id);
      var hit;
      if (msgs.length) {
        hit = msgs.some(function (m) {
          return !(m.author && m.author.id === me) && isWatchedPing(m, me);
        });
      } else {
        hit = !!s.clearUnknown;
      }
      if (hit) { ackChannel(id, null); count++; }
    } catch (e) { console.log(TAG, "scan error", e); }
  });
  dbg("scan: " + scanIds.length + " channels with mentions, cleared " + count);
  return count;
}

var pending = {};

function dbg(text) {
  try {
    if (S().debug) toasts.showToast("ARP: " + text, assets.getAssetIDByName("ic_check"));
    console.log(TAG, text);
  } catch (e) {}
}

function ackChannel(channelId, fallbackMsgId) {
  var RS = store("ReadStateStore");
  var messageId = (RS && RS.lastMessageId && RS.lastMessageId(channelId)) || fallbackMsgId;
  if (!messageId) {
    var ch = store("ChannelStore")?.getChannel?.(channelId);
    messageId = ch && ch.lastMessageId;
  }
  if (!messageId) { dbg("no message id to ack"); return; }
  var entry = [{ channelId: channelId, messageId: messageId, readStateType: 0 }];
  // The real ack util also tells Discord's servers, so the badge doesn't come back after a restart.
  var acker = null;
  try { acker = metro.findByProps("bulkAck", "ack"); } catch (e) {}
  if (acker && typeof acker.bulkAck === "function") {
    acker.bulkAck(entry);
    dbg("acked via bulkAck");
  } else {
    FluxDispatcher.dispatch({ type: "BULK_ACK", context: "APP", channels: entry });
    dbg("acked via dispatch (local only)");
  }
}

function onMessage(action) {
  try {
    var msg = action && action.message;
    if (!msg || action.optimistic || action.isPushNotification) return;
    var channelId = action.channelId || msg.channel_id;
    if (!channelId) return;

    var guildId = action.guildId || msg.guild_id;
    if (!guildId) {
      var ch = store("ChannelStore")?.getChannel?.(channelId);
      guildId = ch && ch.guild_id;
    }
    if (!guildId) return; // never touch DMs

    var me = myId();
    if (msg.author && msg.author.id === me) return;
    if (!isWatchedPing(msg, me)) {
      if (msg.mention_everyone || (msg.mention_roles && msg.mention_roles.length)) dbg("ping seen but not matched");
      return;
    }
    dbg("ping detected, clearing soon");

    if (pending[channelId]) clearTimeout(pending[channelId]);
    var delay = Math.max(0, Number(S().delay) || 0);
    pending[channelId] = setTimeout(function () {
      delete pending[channelId];
      try { ackChannel(channelId, msg.id); } catch (e) { console.log(TAG, "ack failed", e); }
    }, delay);
  } catch (e) {
    console.log(TAG, "handler error", e);
  }
}

// ---------- settings UI ----------
function Settings() {
  var s = S();
  var _a = React.useState(0), force = _a[1];
  var rerender = function () { force(function (n) { return n + 1; }); };
  var _b = React.useState(""), guildInput = _b[0], setGuildInput = _b[1];
  var _c = React.useState(""), roleInput = _c[0], setRoleInput = _c[1];
  var _d = React.useState([]), guildRoles = _d[0], setGuildRoles = _d[1];
  var _e = React.useState(String(s.delay)), delayInput = _e[0], setDelayInput = _e[1];
  var _f = React.useState(""), diag = _f[0], setDiag = _f[1];

  var toast = function (t, icon) { toasts.showToast(t, assets.getAssetIDByName(icon || "ic_check")); };

  var toggleRole = function (id) {
    var i = s.roles.indexOf(id);
    if (i > -1) s.roles.splice(i, 1); else s.roles.push(id);
    rerender();
  };

  var loadGuildRoles = function () {
    var gid = guildInput.trim();
    if (!gid) return;
    try {
      var GuildStore = store("GuildStore");
      if (!GuildStore.getGuild(gid)) { toast("Server not found", "ic_close_16px"); return; }
      var all = rolesOf(gid);
      var mine = myRoleIds(gid);
      var allList = Object.keys(all)
        .filter(function (id) { return id !== gid; }) // drop @everyone role
        .map(function (id) { return { id: id, name: all[id].name || ("Role " + id), pos: all[id].position || 0 }; })
        .sort(function (a, b) { return b.pos - a.pos; });
      var list = mine
        .filter(function (id) { return id !== gid; })
        .map(function (id) { return { id: id, name: (all[id] && all[id].name) || ("Role " + id) }; });
      var note = "Known roles: " + allList.length + ", yours detected: " + list.length + ".";
      if (!list.length && allList.length) {
        list = allList;
        note += " Couldn't detect which roles you have, so showing every role in this server.";
        toast("Showing all server roles", "ic_check");
      } else if (!list.length) {
        toast("No roles found for that server", "ic_close_16px");
      }
      setDiag(note);
      setGuildRoles(list);
    } catch (e) {
      console.log(TAG, "load roles failed", e);
      toast("Couldn't load roles", "ic_close_16px");
    }
  };

  var addRoleById = function () {
    var id = roleInput.trim();
    if (!id) return;
    if (s.roles.indexOf(id) !== -1) { toast("Already added", "ic_close_16px"); return; }
    s.roles.push(id);
    setRoleInput("");
    toast("Role added");
    rerender();
  };

  var h = React.createElement;
  var rows = [];

  rows.push(h(Forms.FormSection, { key: "types", title: "Auto-read these pings" },
    h(Forms.FormSwitchRow, {
      label: "@everyone", value: !!s.everyone,
      onValueChange: function (v) { s.everyone = v; rerender(); }
    }),
    h(Forms.FormSwitchRow, {
      label: "@here", value: !!s.here,
      onValueChange: function (v) { s.here = v; rerender(); }
    }),
    h(Forms.FormSwitchRow, {
      label: "Direct @you mentions", value: !!s.direct,
      onValueChange: function (v) { s.direct = v; rerender(); }
    })
  ));

  rows.push(h(Forms.FormSection, { key: "existing", title: "Pings from before the plugin" },
    h(Forms.FormSwitchRow, {
      label: "Clear existing pings on startup", value: !!s.scanOnLoad,
      onValueChange: function (v) { s.scanOnLoad = v; rerender(); }
    }),
    h(Forms.FormSwitchRow, {
      label: "Also clear channels I can't inspect",
      subLabel: "Old pings whose messages aren't loaded can't be checked, so clear them anyway",
      value: !!s.clearUnknown,
      onValueChange: function (v) { s.clearUnknown = v; rerender(); }
    }),
    h(Forms.FormRow, {
      label: "Clear existing pings now",
      onPress: function () {
        var n = scanExisting();
        toast(n ? "Cleared " + n + " channel" + (n === 1 ? "" : "s") : "Nothing to clear");
      }
    })
  ));

  var selectedRows = s.roles.length
    ? s.roles.map(function (id) {
        return h(Forms.FormRow, {
          key: "sel" + id,
          label: roleName(id),
          subLabel: id + " - tap to remove",
          onPress: function () { toggleRole(id); }
        });
      })
    : [h(Forms.FormText, { key: "none", style: { padding: 12 } }, "No roles selected yet.")];

  rows.push(h.apply(null, [Forms.FormSection, { key: "selroles", title: "Auto-read these roles" }].concat(selectedRows)));

  var pickerChildren = [
    h(Forms.FormText, { key: "help", style: { paddingHorizontal: 12, paddingTop: 8 } },
      "Enter a server ID to list the roles you have there, then tap to toggle."),
    h(Forms.FormInput, {
      key: "gin", placeholder: "Server ID", value: guildInput, onChange: setGuildInput,
      onSubmitEditing: loadGuildRoles
    }),
    h(Forms.FormRow, { key: "load", label: "Load my roles", onPress: loadGuildRoles })
  ];
  if (diag) pickerChildren.push(h(Forms.FormText, { key: "diag", style: { padding: 12 } }, diag));
  guildRoles.forEach(function (r) {
    pickerChildren.push(h(Forms.FormSwitchRow, {
      key: "gr" + r.id, label: r.name, subLabel: r.id,
      value: s.roles.indexOf(r.id) !== -1,
      onValueChange: function () { toggleRole(r.id); }
    }));
  });
  rows.push(h.apply(null, [Forms.FormSection, { key: "picker", title: "Pick roles from a server" }].concat(pickerChildren)));

  rows.push(h(Forms.FormSection, { key: "manual", title: "Or add a role by ID" },
    h(Forms.FormInput, {
      placeholder: "Role ID", value: roleInput, onChange: setRoleInput, onSubmitEditing: addRoleById
    }),
    h(Forms.FormRow, { label: "Add role", onPress: addRoleById })
  ));

  rows.push(h(Forms.FormSection, { key: "debug", title: "Troubleshooting" },
    h(Forms.FormSwitchRow, {
      label: "Debug toasts", subLabel: "Shows what the plugin is doing (ping seen, matched, acked)",
      value: !!s.debug,
      onValueChange: function (v) { s.debug = v; rerender(); }
    })
  ));

  rows.push(h(Forms.FormSection, { key: "delay", title: "Delay before marking read (ms)" },
    h(Forms.FormInput, {
      placeholder: "500", value: delayInput, keyboardType: "number-pad",
      onChange: function (v) {
        setDelayInput(v);
        var n = parseInt(v, 10);
        s.delay = isNaN(n) ? 0 : Math.max(0, n);
      }
    })
  ));

  return h.apply(null, [RN.ScrollView, { contentContainerStyle: { paddingBottom: 80 } }].concat(rows));
}

// ---------- lifecycle ----------
var scanTimers = [];
function onAppState(action) {
  try {
    if (action && action.state === "active" && S().scanOnLoad) {
      scanTimers.push(setTimeout(function () { try { scanExisting(); } catch (e) {} }, 2000));
    }
  } catch (e) {}
}
var plug = {
  onLoad: function () {
    S();
    FluxDispatcher.subscribe("MESSAGE_CREATE", onMessage);
    FluxDispatcher.subscribe("APP_STATE_UPDATE", onAppState);
    if (S().scanOnLoad) {
      // the read state may not be populated right at startup, so retry a few times
      [3000, 10000, 30000].forEach(function (ms) {
        scanTimers.push(setTimeout(function () { try { scanExisting(); } catch (e) {} }, ms));
      });
    }
  },
  onUnload: function () {
    FluxDispatcher.unsubscribe("APP_STATE_UPDATE", onAppState);
    scanTimers.forEach(clearTimeout);
    scanTimers = [];
    FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessage);
    for (var k in pending) clearTimeout(pending[k]);
    pending = {};
  },
  settings: Settings
};

module.exports = { default: plug, __esModule: true };
return module.exports;
})();
