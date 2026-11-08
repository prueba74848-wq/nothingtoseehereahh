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
  delay: 500
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

function roleName(roleId) {
  try {
    var GuildStore = store("GuildStore");
    var guilds = GuildStore.getGuilds();
    for (var gid in guilds) {
      var roles = GuildStore.getRoles(gid);
      if (roles && roles[roleId]) return roles[roleId].name + " (" + guilds[gid].name + ")";
    }
  } catch (e) {}
  return "Unknown role";
}

// ---------- ping detection ----------
function isWatchedPing(msg, me) {
  var s = S();
  var content = msg.content || "";

  if (msg.mention_everyone) {
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

  if (Array.isArray(msg.mention_roles) && s.roles.length) {
    for (var j = 0; j < msg.mention_roles.length; j++) {
      if (s.roles.indexOf(msg.mention_roles[j]) !== -1) return true;
    }
  }
  return false;
}

var pending = {};

function ackChannel(channelId, fallbackMsgId) {
  var ReadStateStore = store("ReadStateStore");
  var messageId = (ReadStateStore && ReadStateStore.lastMessageId && ReadStateStore.lastMessageId(channelId)) || fallbackMsgId;
  FluxDispatcher.dispatch({
    type: "BULK_ACK",
    context: "APP",
    channels: [{ channelId: channelId, messageId: messageId, readStateType: 0 }]
  });
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
    if (!isWatchedPing(msg, me)) return;

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
      var all = GuildStore.getRoles(gid) || {};
      var me = myId();
      var member = store("GuildMemberStore")?.getMember?.(gid, me);
      var mine = (member && member.roles) || [];
      var list = mine
        .map(function (id) { return all[id]; })
        .filter(function (r) { return r && r.id !== gid; }) // drop @everyone role
        .map(function (r) { return { id: r.id, name: r.name }; });
      setGuildRoles(list);
      if (!list.length) toast("You have no roles there", "ic_close_16px");
    } catch (e) {
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
var plug = {
  onLoad: function () {
    S();
    FluxDispatcher.subscribe("MESSAGE_CREATE", onMessage);
  },
  onUnload: function () {
    FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessage);
    for (var k in pending) clearTimeout(pending[k]);
    pending = {};
  },
  settings: Settings
};

module.exports = { default: plug, __esModule: true };
return module.exports;
})();
