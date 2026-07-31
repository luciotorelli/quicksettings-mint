const Applet = imports.ui.applet;
const St = imports.gi.St;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;  
const ModalDialog = imports.ui.modalDialog; 
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Pango = imports.gi.Pango;
const Meta = imports.gi.Meta;

const DEFAULT_TOOLTIP = "Quick Settings";
const BRIGHTNESS_ADJUSTMENT_STEP = 5;

// GNOME's Quick Settings model: the tile body toggles, and the chevron on the
// right opens the matching settings app. Note this is the INVERSE of the
// earlier gear-icon behaviour - it is what the two-part pill shape implies,
// and a pill with no toggle affordance anywhere would be worse. Flip this to
// false to swap the two halves back.
const BODY_TOGGLES = true;

// Tile geometry, shared by the quick toggles so they line up.
const TILE_RADIUS = 14;
const TILE_PILL_RADIUS = 22;
const TILE_IDLE = "rgba(255,255,255,0.07)";
const TILE_HOVER = "rgba(255,255,255,0.13)";

// Only used if the theme lookup below fails; matches Mint-Y-Dark-Orange.
const ACCENT_FALLBACK = "rgb(255,113,57)";

// Panel reveal. The curve must not overshoot: it drives a height and a scale
// that have to stay in lockstep, and EASE_OUT_BACK pushes both past their
// target and back, which shows up as the panel springing.
const PANEL_ANIM_MS = 260;
const PANEL_ANIM_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;

// Reaction times for the strategies that share one curve, so the fan panel can
// say what actually differs between them.
const FAN_REACTION = { medium: "5s", agile: "3s", "very-agile": "2s" };

/**
 * Picks a readable foreground for a filled pill.
 *
 * White on Mint-Y's orange is glaring, but dark text would be unreadable on
 * the darker accents (blue, purple), so this decides from the accent's own
 * perceived brightness rather than assuming either.
 *
 * @param {string} css - An "rgb(r,g,b)" string.
 * @returns {string} A CSS colour.
 */
function contrastOn(css) {
    const parts = String(css).match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!parts) {
        return "#ffffff";
    }
    const r = parseInt(parts[1], 10);
    const g = parseInt(parts[2], 10);
    const b = parseInt(parts[3], 10);
    // Rec. 601 luma. The 0.5 threshold puts Mint-Y's orange (0.58) on the dark
    // side and its blue (0.47) on the light side, which is where they belong.
    const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luma > 0.5 ? "rgba(0,0,0,0.85)" : "#ffffff";
}

/**
 * "power-saver" -> "Power Saver".
 *
 * @param {string} text - Hyphenated or underscored identifier.
 * @returns {string} Title-cased words.
 */
function titleCase(text) {
    return String(text)
        .split(/[-_]/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

/**
 * Reads the accent colour out of the active theme rather than hardcoding one.
 *
 * St has no CSS variables, so the way to stay native across Mint-Y-Blue,
 * -Orange, -Teal and the rest is to ask the theme what it paints a slider
 * with, and reuse that. Falls back to the stock orange if the lookup fails.
 *
 * @returns {string} A CSS colour string.
 */
function themeAccent() {
    let probe = null;
    try {
        // A theme node only resolves once the actor is on the stage.
        probe = new St.Widget({ style_class: "popup-slider-menu-item" });
        global.stage.add_child(probe);
        const [found, color] = probe
            .get_theme_node()
            .lookup_color("-slider-active-background-color", false);
        if (found) {
            return `rgb(${color.red},${color.green},${color.blue})`;
        }
    } catch (e) {
        global.logError("Quick Settings: theme accent lookup failed, using fallback: " + e);
    } finally {
        if (probe) {
            probe.destroy();
        }
    }
    return ACCENT_FALLBACK;
}

/**
 * Monitor class represents an external display and handles brightness and contrast control.
 */
class Monitor {
    /**
     * Constructor to initialize a Monitor object.
     *
     * @param {number} index - The index of the monitor in the system.
     * @param {string} name - The name of the monitor.
     * @param {number} bus - The I2C bus number used by the monitor.
     */
    constructor(index, name, bus) {
        this.index = index;
        this.name = name;
        this.brightness = 50;
        this.contrast = 50;
        this.bus = bus;
        this.menuLabel = null;
        this.menuSlider = null;
        this.promises = Promise.resolve(); // Sequential execution of brightness/contrast commands
    }

    /**
     * Fetches the current brightness value from the monitor and updates the menu.
     * 
     * @returns {Promise} A promise that resolves when the brightness is updated.
     */
    updateBrightness() {
        return new Promise((resolve) => {
            const cmd = `ddcutil --bus=${this.bus} getvcp 10`; // Command to get monitor brightness
            Util.spawnCommandLineAsyncIO(cmd, (stdout, stderr, exitCode) => {
                setTimeout(resolve, 10);
                if (exitCode === 0) {
                    const matchRes = stdout.match(/current value =\s*(\d+)/);
                    if (matchRes && matchRes[1]) {
                        this.brightness = parseInt(matchRes[1], 10);
                        this.updateMenu(); // Update UI with new brightness value
                    }
                } else {
                    global.logError(`cmd: "${cmd}" returned exit code ${exitCode}`);
                    global.logError(stderr);
                }
            });
        });
    }

    /**
     * Fetches the current contrast value from the monitor and updates the menu.
     * 
     * @returns {Promise} A promise that resolves when the contrast is updated.
     */
    updateContrast() {
        return new Promise((resolve) => {
            const cmd = `ddcutil --bus=${this.bus} getvcp 12`; // Command to get monitor contrast
            Util.spawnCommandLineAsyncIO(cmd, (stdout, stderr, exitCode) => {
                setTimeout(resolve, 10);
                if (exitCode === 0) {
                    const matchRes = stdout.match(/current value =\s*(\d+)/);
                    if (matchRes && matchRes[1]) {
                        this.contrast = parseInt(matchRes[1], 10);
                        this.updateMenu(); // Update UI with new contrast value
                    }
                } else {
                    global.logError(`cmd: "${cmd}" returned exit code ${exitCode}`);
                    global.logError(stderr);
                }
            });
        });
    }

    /**
     * Updates the captions above each slider to reflect the current values.
     * The monitor's own label carries just the name now that each slider
     * states its own percentage.
     */
    updateLabel() {
        // The popup shows bare icon+bar rows now, so there are no captions to
        // maintain. Kept as a hook so updateMenu() reads the same either way.
    }

    /**
     * Updates the monitor's menu with the current brightness and contrast values.
     */
    updateMenu() {
        this.updateLabel();
        if (this.menuSlider) {
            this.menuSlider.setValue(this.brightness / 100); // Set slider to current brightness value
        }
        if (this.contrastSlider) {
            this.contrastSlider.setValue(this.contrast / 100); // Contrast tracked the same way
        }
    }

    /**
     * Sets the brightness value for the monitor and updates the UI. Sends the new value to the monitor.
     * 
     * @param {number} value - The new brightness value to set.
     */
    setBrightness(value) {
        this.brightness = Math.round(value);
        this.updateMenu(); // Reflect the change in the UI
        this.promises = this.promises.then(() => {
            return new Promise((resolve, reject) => {
                Util.spawnCommandLineAsync(
                    `ddcutil --bus=${this.bus} setvcp 10 ${this.brightness}`, // Command to set brightness
                    resolve,
                    reject
                );
            });
        });
    }

    /**
     * Sets the contrast value for the monitor and updates the UI. Sends the new value to the monitor.
     * 
     * @param {number} value - The new contrast value to set.
     */
    setContrast(value) {
        this.contrast = Math.round(value);
        this.updateMenu(); // Reflect the change in the UI
        this.promises = this.promises.then(() => {
            return new Promise((resolve, reject) => {
                Util.spawnCommandLineAsync(
                    `ddcutil --bus=${this.bus} setvcp 12 ${this.contrast}`, // Command to set contrast
                    resolve,
                    reject
                );
            });
        });
    }

}
/**
 * Reads the laptop panel backlight through the Cinnamon settings daemon.
 *
 * Going through csd rather than /sys/class/backlight matters: the sysfs node
 * is root-owned, and csd already holds the privileged helper. GetPercentage
 * is a method, not a property - asking for a "Brightness" property returns
 * InvalidArgs and reads as though the interface were missing.
 *
 * @param {Function} callback - Receives the percentage, or null on failure.
 */
function getPanelBrightness(callback) {
    Gio.DBus.session.call(
        "org.cinnamon.SettingsDaemon.Power",
        "/org/cinnamon/SettingsDaemon/Power",
        "org.cinnamon.SettingsDaemon.Power.Screen",
        "GetPercentage",
        null, null, Gio.DBusCallFlags.NONE, -1, null,
        (conn, res) => {
            try {
                callback(conn.call_finish(res).deep_unpack()[0]);
            } catch (e) {
                callback(null);
            }
        }
    );
}

/**
 * Sets the laptop panel backlight.
 *
 * @param {number} percent - 0-100.
 */
function setPanelBrightness(percent) {
    Gio.DBus.session.call(
        "org.cinnamon.SettingsDaemon.Power",
        "/org/cinnamon/SettingsDaemon/Power",
        "org.cinnamon.SettingsDaemon.Power.Screen",
        "SetPercentage",
        new GLib.Variant("(u)", [Math.max(0, Math.min(100, percent))]),
        null, Gio.DBusCallFlags.NONE, -1, null, null
    );
}

/**
 * Reads a boolean GSettings key, returning a default if the schema is absent.
 *
 * @param {string} schema - Schema id.
 * @param {string} key - Key name.
 * @param {boolean} fallback - Returned if the lookup throws.
 * @returns {boolean} The value.
 */
function getBool(schema, key, fallback) {
    try {
        return new Gio.Settings({ schema_id: schema }).get_boolean(key);
    } catch (e) {
        return fallback;
    }
}

/**
 * Writes a boolean GSettings key, ignoring a missing schema.
 *
 * @param {string} schema - Schema id.
 * @param {string} key - Key name.
 * @param {boolean} value - Value to write.
 */
function setBool(schema, key, value) {
    try {
        new Gio.Settings({ schema_id: schema }).set_boolean(key, value);
    } catch (e) {
        global.logError("Quick Settings: could not write " + schema + " " + key + ": " + e);
    }
}

/**
 * A GNOME-style quick settings pill.
 *
 * Two visually distinct segments in one rounded tile: the body, and - where
 * the spec offers somewhere to go - a chevron with its own background behind
 * a hairline divider, rounded to match the pill's right edge. St does not clip
 * children to a parent's border-radius, so the chevron carries its own
 * radius rather than relying on the tile to mask it.
 */
class QuickTile {
    /**
     * @param {object} spec - Tile definition.
     * @param {string} accent - Theme accent used for the active state.
     * @param {object} handlers - `{ onExpand, onLaunch }` callbacks.
     */
    constructor(spec, accent, handlers) {
        this.spec = spec;
        this.accent = accent;
        // Derived once so _paint() does not recompute it on every hover.
        this.foreground = contrastOn(accent);
        this.darkForeground = this.foreground.indexOf("rgba(0,") === 0;
        this.active = false;
        this.hovered = false;

        this.actor = new St.BoxLayout({ vertical: false, reactive: true });
        this.actor.set_x_expand(true);

        const inner = new St.BoxLayout({ vertical: false, style: "spacing: 10px;" });
        this.icon = new St.Icon({
            icon_name: spec.icon,
            icon_type: St.IconType.SYMBOLIC,
            icon_size: 18,
        });
        inner.add_child(this.icon);

        const text = new St.BoxLayout({ vertical: true });
        this.titleLabel = new St.Label({ text: spec.title });
        text.add_child(this.titleLabel);
        this.subtitleLabel = new St.Label({ text: "" });
        // The SSID lands after the tile is laid out; without this it would be
        // ellipsized to fit the empty placeholder's width.
        this.subtitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.subtitleLabel.hide();
        text.add_child(this.subtitleLabel);
        inner.add_child(text);

        // A pill without onToggle is a multi-choice one (Power Mode, Fan
        // Curve): there is nothing binary to flip, so both halves navigate.
        const toggleAction = spec.onToggle
            ? () => {
                  this.setActive(!this.active);
                  spec.onToggle(this.active);
              }
            : null;
        // The chevron either expands an inline panel or launches an app.
        const chevronAction = spec.expand
            ? () => handlers.onExpand(spec.expand)
            : spec.onOpen
            ? () => handlers.onLaunch(spec.onOpen)
            : null;

        this.body = new St.Button({ child: inner, x_expand: true });
        const bodyAction =
            (BODY_TOGGLES || !chevronAction ? toggleAction : chevronAction) ||
            chevronAction;
        if (bodyAction) {
            this.body.connect("clicked", bodyAction);
        }
        this.actor.add_child(this.body);

        if (chevronAction) {
            this.chevron = new St.Button({
                child: new St.Icon({
                    icon_name: "go-next-symbolic",
                    icon_type: St.IconType.SYMBOLIC,
                    icon_size: 14,
                }),
            });
            this.chevron.connect(
                "clicked",
                (BODY_TOGGLES ? chevronAction : toggleAction) || chevronAction
            );
            this.actor.add_child(this.chevron);
        }

        this.actor.connect("enter-event", () => {
            this.hovered = true;
            this._paint();
        });
        this.actor.connect("leave-event", () => {
            this.hovered = false;
            this._paint();
        });

        this._paint();
    }

    /**
     * Repaints the tile for its current active/hover state.
     *
     * @private
     */
    _paint() {
        const background = this.active
            ? this.accent
            : this.hovered
            ? TILE_HOVER
            : TILE_IDLE;

        // No padding on the tile itself - each segment pads its own content, so
        // the chevron's background reaches the pill edge.
        this.actor.set_style(
            "padding: 0px; transition-duration: 150;" +
            "border-radius: " + TILE_PILL_RADIUS + "px;" +
            "background-color: " + background + ";"
        );
        this.body.set_style(
            "background-color: transparent; border: none;" +
            "padding: 9px 14px;" +
            "border-radius: " + TILE_PILL_RADIUS + "px 0px 0px " + TILE_PILL_RADIUS + "px;"
        );

        if (this.active) {
            const muted = this.darkForeground
                ? "rgba(0,0,0,0.6)"
                : "rgba(255,255,255,0.8)";
            this.titleLabel.set_style("font-weight: bold; color: " + this.foreground + ";");
            this.subtitleLabel.set_style("font-size: 0.8em; color: " + muted + ";");
            this.icon.set_style("color: " + this.foreground + ";");
        } else {
            this.titleLabel.set_style("font-weight: bold;");
            this.subtitleLabel.set_style("font-size: 0.8em;");
            this.icon.set_style(null);
        }

        if (this.chevron) {
            // Darken over the accent, lighten over the idle grey - either way
            // the segment separates from the body without inventing a colour.
            const segment = this.active
                ? "rgba(0,0,0,0.20)"
                : "rgba(255,255,255,0.07)";
            const divider = !this.active
                ? "rgba(255,255,255,0.14)"
                : this.darkForeground
                ? "rgba(0,0,0,0.28)"
                : "rgba(255,255,255,0.30)";
            this.chevron.set_style(
                "padding: 9px 13px;" +
                "background-color: " + segment + ";" +
                "border-left: 1px solid " + divider + ";" +
                "border-radius: 0px " + TILE_PILL_RADIUS + "px " + TILE_PILL_RADIUS + "px 0px;" +
                (this.active ? "color: " + this.foreground + ";" : "")
            );
        }
    }

    /**
     * @param {boolean} state - New active state.
     */
    setActive(state) {
        this.active = Boolean(state);
        this._paint();
    }

    /**
     * @param {string} iconName - Replacement symbolic icon.
     */
    setIcon(iconName) {
        if (iconName) {
            this.icon.set_icon_name(iconName);
        }
    }

    /**
     * @param {string} text - Secondary line; hidden when empty.
     */
    setSubtitle(text) {
        if (text) {
            this.subtitleLabel.set_text(text);
            this.subtitleLabel.show();
        } else {
            this.subtitleLabel.hide();
        }
    }
}

/**
 * QuickSettingsApplet - a GNOME-style control centre for Cinnamon.
 *
 * Layout, top to bottom: a header strip (battery plus screenshot, settings,
 * lock and power buttons), full-width volume and panel-brightness sliders, a
 * two-column grid of toggle pills, then the DDC/CI monitor controls.
 *
 * @extends Applet.IconApplet
 */
class QuickSettingsApplet extends Applet.IconApplet {
    /**
     * Constructor for initializing the QuickSettingsApplet.
     *
     * @param {object} metadata - The applet metadata.
     * @param {string} orientation - The orientation of the applet in the panel.
     * @param {number} panel_height - The height of the panel in which the applet resides.
     * @param {number} instance_id - The unique ID for the applet instance.
     */
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);
        this.detecting = false;
        this.set_applet_icon_symbolic_name("preferences-system");
        this.set_applet_tooltip(DEFAULT_TOOLTIP);
        this.actor.connect("scroll-event", (...args) => this._onScrollEvent(...args));
        this.lastTooltipTimeoutID = null;
        this.monitors = [];
        this.tiles = {};
        this.expandedKey = null;
        this.panelCache = {};   // key -> row descriptors, warmed on open
        this.panelSlots = {};   // key -> { host, index } for insertion
        this.panelActor = null;

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this._addMenuItems();
        this.updateStatus();
    }

    /**
     * Sets up the accent, draws the shell, then goes looking for displays.
     *
     * @private
     */
    _addMenuItems() {
        this.accent = themeAccent();
        this.updateMenu();
        this.updateMonitors();
    }

    /**
     * A round icon button for the header strip.
     *
     * @param {string} iconName - Symbolic icon name.
     * @param {string} command - Command line to run.
     * @returns {object} The button actor.
     * @private
     */
    _circleButton(iconName, command) {
        const button = new St.Button({
            child: new St.Icon({
                icon_name: iconName,
                icon_type: St.IconType.SYMBOLIC,
                icon_size: 16,
            }),
        });
        const paint = (hovered) =>
            button.set_style(
                "width: 32px; height: 32px; border-radius: 16px;" +
                "transition-duration: 150;" +
                "background-color: " + (hovered ? TILE_HOVER : TILE_IDLE) + ";"
            );
        paint(false);
        button.connect("enter-event", () => paint(true));
        button.connect("leave-event", () => paint(false));
        button.connect("clicked", () => {
            this.menu.close(true);
            Util.spawnCommandLine(command);
        });
        return button;
    }

    /**
     * Header strip: battery readout on the left, system actions on the right.
     *
     * @returns {object} The row actor.
     * @private
     */
    _buildHeader() {
        const row = new St.BoxLayout({ vertical: false, style: "spacing: 6px;" });
        row.set_x_expand(true);

        const battery = new St.BoxLayout({ vertical: false });
        battery.set_style(
            "spacing: 6px; padding: 6px 14px; border-radius: 16px;" +
            "background-color: " + TILE_IDLE + ";"
        );
        this.batteryIcon = new St.Icon({
            icon_name: "battery-good-symbolic",
            icon_type: St.IconType.SYMBOLIC,
            icon_size: 16,
        });
        battery.add_child(this.batteryIcon);
        this.batteryLabel = new St.Label({
            text: "--%",
            y_align: Clutter.ActorAlign.CENTER,
        });
        // The percentage arrives asynchronously, after this pill has already
        // been allocated for the placeholder. Without this the longer text is
        // ellipsized to "..." rather than triggering a relayout.
        this.batteryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        battery.add_child(this.batteryLabel);
        row.add_child(battery);

        const spacer = new St.Widget();
        spacer.set_x_expand(true);
        row.add_child(spacer);

        row.add_child(this._circleButton("applets-screenshooter-symbolic", "gnome-screenshot -i"));
        row.add_child(this._circleButton("emblem-system-symbolic", "cinnamon-settings"));
        row.add_child(this._circleButton("changes-prevent-symbolic", "cinnamon-screensaver-command --lock"));
        row.add_child(this._circleButton("system-shutdown-symbolic", "cinnamon-session-quit --power-off"));

        return row;
    }

    /**
     * A slider styled to match the rest of the popup.
     *
     * @param {string} minWidth - CSS min-width for the track.
     * @returns {object} The PopupSliderMenuItem.
     * @private
     */
    _makeSlider(minWidth) {
        const slider = new PopupMenu.PopupSliderMenuItem(0);
        slider._slider.set_style(
            "min-width: " + minWidth + ";" +
            "-slider-height: 0.5em;" +
            "-slider-handle-radius: 0.55em;" +
            "-slider-active-background-color: " + this.accent + ";" +
            "-slider-background-color: rgba(255,255,255,0.12);"
        );
        slider.actor.set_style("padding: 0px;");
        slider.actor.set_x_expand(true);
        return slider;
    }

    /**
     * A small borderless icon button with a hover wash.
     *
     * @param {string} iconName - Symbolic icon name.
     * @param {number} size - Icon size.
     * @param {Function} onClick - Click handler.
     * @returns {object} The button actor.
     * @private
     */
    _iconButton(iconName, size, onClick) {
        const button = new St.Button({
            child: new St.Icon({
                icon_name: iconName,
                icon_type: St.IconType.SYMBOLIC,
                icon_size: size,
            }),
        });
        const paint = (hovered) =>
            button.set_style(
                "padding: 5px; border-radius: 12px; transition-duration: 150;" +
                "background-color: " + (hovered ? TILE_HOVER : "transparent") + ";"
            );
        paint(false);
        button.connect("enter-event", () => paint(true));
        button.connect("leave-event", () => paint(false));
        button.connect("clicked", onClick);
        return button;
    }

    /**
     * One full-width slider with a leading icon, and optionally a trailing
     * chevron that opens a panel.
     *
     * @param {string} iconName - Symbolic icon name.
     * @param {Function} onCommit - Called with 0-100 on drag-end.
     * @param {string} [expandKey] - Panel to open from the chevron.
     * @returns {object} `{ actor, slider }`.
     * @private
     */
    _sliderRow(iconName, onCommit, expandKey) {
        const row = new St.BoxLayout({ vertical: false, style: "spacing: 12px; padding: 2px 6px;" });
        row.set_x_expand(true);
        row.add_child(
            new St.Icon({
                icon_name: iconName,
                icon_type: St.IconType.SYMBOLIC,
                icon_size: 18,
            })
        );

        const slider = this._makeSlider("14em");
        // Commit on drag-end only. Firing on value-changed would spawn a
        // process per motion event.
        slider.connect("drag-end", (s) => onCommit(Math.round(100 * s.value)));
        row.add_child(slider.actor);

        if (expandKey) {
            row.add_child(
                this._iconButton("go-next-symbolic", 14, () => this._toggleExpansion(expandKey))
            );
        }

        return { actor: row, slider };
    }

    /**
     * Brightness and contrast for one monitor, side by side on one line, with
     * the re-detect button closing the row.
     *
     * @param {object} monitor - The Monitor to bind to.
     * @returns {object} The row actor.
     * @private
     */
    _monitorRow(monitor) {
        const row = new St.BoxLayout({ vertical: false, style: "spacing: 8px; padding: 2px 6px;" });
        row.set_x_expand(true);

        const pair = (iconName, onCommit) => {
            row.add_child(
                new St.Icon({
                    icon_name: iconName,
                    icon_type: St.IconType.SYMBOLIC,
                    icon_size: 18,
                })
            );
            const slider = this._makeSlider("5em");
            slider.connect("drag-end", (s) => onCommit(Math.round(100 * s.value)));
            row.add_child(slider.actor);
            return slider;
        };

        monitor.menuSlider = pair("video-display-symbolic", (v) => monitor.setBrightness(v));
        monitor.contrastSlider = pair("preferences-color-symbolic", (v) => monitor.setContrast(v));

        row.add_child(
            this._iconButton("emblem-synchronizing-symbolic", 16, () => {
                if (this.detecting) {
                    return;
                }
                const infoOSD = new ModalDialog.InfoOSD("Detecting displays...");
                infoOSD.show();
                this.updateMonitors(false).then(
                    () => this.menu.open(true),
                    (e) => global.logError("Error: " + e)
                ).then(() => infoOSD.destroy());
            })
        );

        monitor.updateMenu(); // push the values already read onto the sliders
        return row;
    }

    /**
     * The toggle pills, in the order they appear in the grid.
     *
     * `expand` opens an inline panel; `onOpen` launches an app instead.
     *
     * @returns {Array<object>} Tile specs.
     * @private
     */
    _tileSpecs() {
        return [
            {
                key: "wifi",
                icon: "network-wireless-symbolic",
                title: _("Wi-Fi"),
                expand: "wifi",
                onToggle: (state) => this._setWifi(state),
            },
            {
                key: "bluetooth",
                icon: "bluetooth-symbolic",
                title: _("Bluetooth"),
                expand: "bluetooth",
                onToggle: (state) => this._setBluetooth(state),
            },
            // Multi-choice pills: no onToggle, so both halves open the panel.
            {
                key: "power",
                icon: "power-profile-balanced-symbolic",
                title: _("Power Mode"),
                expand: "power",
            },
            {
                key: "fan",
                icon: "weather-windy-symbolic",
                title: _("Fan Curve"),
                expand: "fan",
            },
            {
                key: "nightlight",
                icon: "night-light-symbolic",
                title: _("Night Light"),
                onToggle: (state) =>
                    setBool("org.cinnamon.settings-daemon.plugins.color", "night-light-enabled", state),
                onOpen: "cinnamon-settings nightlight",
            },
            {
                key: "airplane",
                icon: "airplane-mode-symbolic",
                title: _("Airplane Mode"),
                onToggle: (state) => this._setAirplane(state),
            },
        ];
    }

    /**
     * Opens or closes an inline panel.
     *
     * @param {string} key - Panel key, or the open one to close it.
     * @private
     */
    _toggleExpansion(key) {
        const opening = this.expandedKey !== key;
        this.expandedKey = opening ? key : null;

        if (opening && !this.panelCache[key]) {
            // Cold cache: wait for the rows rather than opening an empty panel
            // and filling it in. The prefetch on open usually means we never
            // get here, but when we do, a short pause beats a panel that
            // visibly assembles itself.
            this._fetchPanel(key, (rows) => {
                this.panelCache[key] = rows;
                if (this.expandedKey === key) {
                    this._syncExpansion();
                }
            });
            return;
        }
        this._syncExpansion();
    }

    /**
     * Swaps the open panel in or out without rebuilding the rest of the popup.
     *
     * This used to call updateMenu(), which tore down and recreated every
     * widget - header, sliders, all six pills - and then re-read the whole
     * system state, spawning about eight processes. All of that ran before the
     * animation got a chance to start, which is what made the reveal look
     * frozen. Only the panel actually changes, so only the panel is touched.
     *
     * @private
     */
    _syncExpansion() {
        const previous = this.panelActor;
        this.panelActor = null;

        if (previous && !previous.is_finalized()) {
            if (this.expandedKey) {
                // Switching panels: drop the old one at once. Two panels
                // animating opposite ways at the same time reads as a glitch.
                previous.destroy();
            } else {
                this._animateOut(previous);
            }
        }

        if (!this.expandedKey) {
            return;
        }
        const slot = this.panelSlots[this.expandedKey];
        if (!slot || slot.host.is_finalized()) {
            return;
        }
        this.panelActor = this._buildExpansionPanel(this.expandedKey);
        slot.host.insert_child_at_index(this.panelActor, slot.index);
        // Insert and animate in the same turn, so no frame is ever painted
        // with the panel at full height.
        this._animateIn(this.panelActor, slot.host.get_width());
    }

    /**
     * Warms the panel caches shortly after the popup opens.
     *
     * A cold panel has to shell out before it knows its own contents, so it
     * would open at placeholder height and resize once the rows landed. By the
     * time a chevron is actually clicked this has usually finished, so the
     * panel renders at its true size immediately.
     *
     * The fetches are staggered rather than fired together: five panels is a
     * dozen subprocesses, and launching them in one go stutters the very frame
     * the popup is trying to draw.
     *
     * @private
     */
    _prefetchPanels() {
        ["power", "fan", "audio", "wifi", "bluetooth"].forEach((key, i) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 120 * i, () => {
                if (this.menu.isOpen) {
                    this._fetchPanel(key, (rows) => {
                        this.panelCache[key] = rows;
                    });
                }
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    /**
     * Re-reads one panel after an action changed the thing it lists.
     *
     * @param {string} key - Panel to invalidate.
     * @private
     */
    _invalidatePanel(key) {
        delete this.panelCache[key];
        // Let the command land before asking what changed.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            if (this.expandedKey === key) {
                this._syncExpansion();
            }
            this.updateStatus();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Grows a freshly built panel open.
     *
     * Two things move together. The shell's height is tweened 0 -> natural,
     * which forces every ancestor to re-allocate each frame so the popup grows
     * smoothly rather than snapping. The content inside is scaled vertically
     * over exactly the same duration and curve.
     *
     * The scale is the part that matters for how it reads. Clipping a growing
     * box on its own uncovers the rows one after another as the clip edge
     * passes them, which looks like text being typed out. Scaling the content
     * in step keeps its bottom edge pinned to the clip edge, so every row is
     * present from the first frame and the whole panel unfolds as one piece.
     *
     * The target is measured before the height is pinned, because set_height()
     * sets the natural height too - measure after and you read back the zero.
     * The height is released to -1 on completion, which corrects the small
     * error from measuring an unparented actor and lets a later cache refresh
     * resize the panel normally.
     *
     * @param {object} panel - The panel actor.
     * @private
     */
    _animateIn(panel, forWidth) {
        // Measure at the width the panel will actually be given. An unparented
        // actor measured at -1 reported 260px for a panel that is really 626px,
        // so the tween finished at 40% and then snapped the rest of the way -
        // which is what made the rows look like they were loading in.
        const natural = panel.get_preferred_height(forWidth > 0 ? forWidth : -1)[1];
        const content = panel._content;

        panel.opacity = 0;
        if (natural <= 0 || !content) {
            // Could not measure; fall back to a plain fade so something happens.
            Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                if (!panel.is_finalized()) {
                    panel.ease({
                        opacity: 255,
                        duration: PANEL_ANIM_MS,
                        mode: PANEL_ANIM_MODE,
                    });
                }
                return false;
            });
            return;
        }

        panel.set_clip_to_allocation(true);
        panel.set_height(0);
        content.set_pivot_point(0.5, 0);
        content.scale_y = 0;

        Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (panel.is_finalized()) {
                return false;
            }
            panel.ease({
                height: natural,
                opacity: 255,
                duration: PANEL_ANIM_MS,
                mode: PANEL_ANIM_MODE,
                onComplete: () => {
                    if (panel.is_finalized()) {
                        return;
                    }
                    panel.set_height(-1);
                    panel.set_clip_to_allocation(false);
                },
            });
            content.ease({
                scale_y: 1,
                duration: PANEL_ANIM_MS,
                mode: PANEL_ANIM_MODE,
            });
            return false;
        });
    }

    /**
     * Folds a panel closed, then destroys it.
     *
     * The mirror of _animateIn, so the popup contracts the same way it grew
     * rather than the panel simply vanishing.
     *
     * @param {object} panel - The panel actor.
     * @private
     */
    _animateOut(panel) {
        if (!panel || panel.is_finalized()) {
            return;
        }
        const duration = Math.round(PANEL_ANIM_MS * 0.75);
        const content = panel._content;

        panel.set_clip_to_allocation(true);
        panel.set_height(panel.get_height()); // pin the current height first

        if (content) {
            content.set_pivot_point(0.5, 0);
            content.ease({ scale_y: 0, duration: duration, mode: PANEL_ANIM_MODE });
        }
        panel.ease({
            height: 0,
            opacity: 0,
            duration: duration,
            mode: PANEL_ANIM_MODE,
            onStopped: () => {
                if (!panel.is_finalized()) {
                    panel.destroy();
                }
            },
        });
    }

    /**
     * One row inside an expansion panel: icon, name, and a trailing action.
     *
     * @param {string} iconName - Symbolic icon name.
     * @param {string} label - Row text.
     * @param {string} actionText - Trailing button caption.
     * @param {Function} onAction - Click handler.
     * @returns {object} The row actor.
     * @private
     */
    _panelRow(iconName, label, actionText, onAction) {
        const row = new St.BoxLayout({ vertical: false, style: "spacing: 10px; padding: 3px 2px;" });
        row.set_x_expand(true);
        row.add_child(
            new St.Icon({
                icon_name: iconName,
                icon_type: St.IconType.SYMBOLIC,
                icon_size: 16,
            })
        );
        const name = new St.Label({ text: label, y_align: Clutter.ActorAlign.CENTER });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(name);

        const spacer = new St.Widget();
        spacer.set_x_expand(true);
        row.add_child(spacer);

        const action = new St.Button({
            child: new St.Label({ text: actionText, y_align: Clutter.ActorAlign.CENTER }),
        });
        const paint = (hovered) =>
            action.set_style(
                "border: none; padding: 3px 8px; border-radius: 10px;" +
                "background-color: " + (hovered ? TILE_HOVER : "transparent") + ";"
            );
        paint(false);
        action.connect("enter-event", () => paint(true));
        action.connect("leave-event", () => paint(false));
        action.connect("clicked", onAction);
        row.add_child(action);

        return row;
    }

    /**
     * A dim one-line message used when a panel list is empty.
     *
     * @param {string} text - Message.
     * @returns {object} A label actor.
     * @private
     */
    _panelNote(text) {
        const label = new St.Label({ text: text });
        label.set_style("padding: 4px 2px; color: rgba(255,255,255,0.45);");
        return label;
    }

    /**
     * A small uppercase heading used to split a panel into groups.
     *
     * @param {string} text - Heading text.
     * @returns {object} A label actor.
     * @private
     */
    _panelHeading(text) {
        const label = new St.Label({ text: text.toUpperCase() });
        label.set_style(
            "font-size: 0.7em; font-weight: bold; padding: 6px 2px 1px 2px;" +
            "color: rgba(255,255,255,0.45);"
        );
        return label;
    }

    /**
     * Runs commands one after another and hands back all their output.
     *
     * @param {Array<string>} commands - Command lines.
     * @param {Function} done - Receives an array of stdout strings.
     * @private
     */
    _runAll(commands, done) {
        const out = [];
        const step = (i) => {
            if (i >= commands.length) {
                done(out);
                return;
            }
            Util.spawnCommandLineAsyncIO(commands[i], (stdout) => {
                out.push(String(stdout));
                step(i + 1);
            });
        };
        step(0);
    }

    /**
     * Turns row descriptors into actors.
     *
     * Panels are described as plain data so a result can be cached and
     * re-rendered instantly on the next open.
     *
     * @param {object} list - Container to fill.
     * @param {Array<object>} rows - Descriptors.
     * @private
     */
    _renderRows(list, rows) {
        list.destroy_all_children();
        rows.forEach((row) => {
            if (row.kind === "heading") {
                list.add_child(this._panelHeading(row.text));
            } else if (row.kind === "note") {
                list.add_child(this._panelNote(row.text));
            } else {
                list.add_child(this._panelRow(row.icon, row.label, row.action, row.run));
            }
        });
    }

    /**
     * Dispatches to the right fetcher for a panel.
     *
     * @param {string} key - Panel key.
     * @param {Function} cb - Receives an array of row descriptors.
     * @private
     */
    _fetchPanel(key, cb) {
        const fetchers = {
            wifi: (c) => this._fetchWifi(c),
            bluetooth: (c) => this._fetchBluetooth(c),
            audio: (c) => this._fetchAudio(c),
            power: (c) => this._fetchPower(c),
            fan: (c) => this._fetchFan(c),
        };
        if (fetchers[key]) {
            fetchers[key](cb);
        }
    }

    /**
     * The inline panel a chevron opens: header, live list, footer action.
     *
     * @param {string} key - Panel key.
     * @returns {object} The panel actor.
     * @private
     */
    _buildExpansionPanel(key) {
        const meta = {
            wifi: {
                icon: "network-wireless-symbolic",
                title: _("Wi-Fi"),
                link: _("Wi-Fi Settings"),
                command: "cinnamon-settings network",
            },
            bluetooth: {
                icon: "bluetooth-symbolic",
                title: _("Bluetooth"),
                link: _("Bluetooth Settings"),
                command: "blueman-manager",
            },
            audio: {
                icon: "audio-volume-high-symbolic",
                title: _("Sound"),
                link: _("Sound Settings"),
                command: "cinnamon-settings sound",
            },
            power: {
                icon: "power-profile-balanced-symbolic",
                title: _("Power Mode"),
                link: _("Power Settings"),
                command: "cinnamon-settings power",
            },
            fan: {
                icon: "weather-windy-symbolic",
                title: _("Fan Curve"),
                // No GUI exists for fw-fanctrl, so the footer runs the reset
                // rather than launching something.
                link: _("Reset to Default"),
                onLink: () => {
                    GLib.spawn_command_line_async("fw-fanctrl reset");
                    this._invalidatePanel("fan");
                },
            },
        }[key];

        // Two layers on purpose. The outer shell is what gets clipped and
        // height-tweened; the inner content is scaled to match, so the rows
        // unfold together instead of being uncovered one at a time.
        const panel = new St.BoxLayout({ vertical: true });
        panel.set_x_expand(true);
        panel.set_style(
            "border-radius: 18px; background-color: rgba(255,255,255,0.06);"
        );

        const content = new St.BoxLayout({ vertical: true });
        content.set_x_expand(true);
        content.set_style("padding: 12px 14px; spacing: 6px;");
        panel.add_child(content);
        panel._content = content;

        const header = new St.BoxLayout({ vertical: false, style: "spacing: 12px; padding-bottom: 4px;" });
        const badge = new St.Bin({
            child: new St.Icon({
                icon_name: meta.icon,
                icon_type: St.IconType.SYMBOLIC,
                icon_size: 18,
            }),
        });
        badge.set_style(
            "width: 34px; height: 34px; border-radius: 17px; color: #ffffff;" +
            "background-color: " + this.accent + ";"
        );
        header.add_child(badge);
        const title = new St.Label({ text: meta.title, y_align: Clutter.ActorAlign.CENTER });
        title.set_style("font-size: 1.15em; font-weight: bold;");
        header.add_child(title);
        content.add_child(header);

        const list = new St.BoxLayout({ vertical: true, style: "spacing: 1px;" });
        list.set_x_expand(true);
        content.add_child(list);

        const rule = new St.Widget();
        rule.set_style("height: 1px; margin: 6px 0px; background-color: rgba(255,255,255,0.12);");
        content.add_child(rule);

        const link = new St.Button({ child: new St.Label({ text: meta.link }) });
        link.set_style("background-color: transparent; border: none; padding: 3px 2px;");
        link.connect("clicked", () => {
            if (meta.onLink) {
                meta.onLink();
                return;
            }
            this.menu.close(true);
            Util.spawnCommandLine(meta.command);
        });
        content.add_child(link);

        // Rows are always already known here - _toggleExpansion will not open a
        // panel until they are. Rendering a placeholder and swapping in the
        // real rows a moment later is exactly what made the contents appear to
        // load in progressively, so there is deliberately no re-fetch on open.
        // Freshness comes from the prefetch on open and from _invalidatePanel
        // after an action.
        this._renderRows(list, this.panelCache[key] || []);

        // Note: no _animateIn here. It needs the panel parented and needs to
        // know the width it will occupy before it can measure a target height,
        // so _syncExpansion drives it right after insertion.
        return panel;
    }

    /**
     * Builds the Sound panel's rows from pactl.
     *
     * @param {Function} cb - Receives row descriptors.
     * @private
     */
    _fetchAudio(cb) {
        this._runAll(
            ["pactl -f json list sinks", "pactl -f json list sources", "pactl info"],
            ([sinkOut, sourceOut, info]) => {
                const rows = [];
                const defaultOf = (label) => {
                    const m = info.match(new RegExp("^" + label + ":\\s*(.+)$", "m"));
                    return m ? m[1].trim() : "";
                };
                const parse = (json) => {
                    try {
                        return JSON.parse(json);
                    } catch (e) {
                        return [];
                    }
                };

                const group = (heading, devices, current, iconName, setCommand, key) => {
                    if (!devices.length) {
                        return;
                    }
                    rows.push({ kind: "heading", text: heading });
                    devices.forEach((device) => {
                        const isCurrent = device.name === current;
                        rows.push({
                            kind: "row",
                            icon: iconName,
                            label: device.description || device.name,
                            action: isCurrent ? _("Active") : _("Select"),
                            run: () => {
                                if (isCurrent) {
                                    return;
                                }
                                GLib.spawn_command_line_async(
                                    setCommand + " " + GLib.shell_quote(device.name)
                                );
                                this._invalidatePanel("audio");
                            },
                        });
                    });
                };

                group(
                    _("Output"),
                    parse(sinkOut),
                    defaultOf("Default Sink"),
                    "audio-speakers-symbolic",
                    "pactl set-default-sink"
                );
                // .monitor sources are loopbacks of each sink, not real inputs.
                group(
                    _("Input"),
                    parse(sourceOut).filter((d) => !String(d.name).endsWith(".monitor")),
                    defaultOf("Default Source"),
                    "audio-input-microphone-symbolic",
                    "pactl set-default-source"
                );

                if (!rows.length) {
                    rows.push({ kind: "note", text: _("No audio devices found") });
                }
                cb(rows);
            }
        );
    }

    /**
     * Builds the Power Mode panel's rows from power-profiles-daemon.
     *
     * @param {Function} cb - Receives row descriptors.
     * @private
     */
    _fetchPower(cb) {
        this._runAll(["powerprofilesctl list"], ([out]) => {
            const rows = [];
            // Lines look like "  balanced:" or "* power-saver:" for the active
            // one; the indented driver lines below each are ignored.
            String(out).split("\n").forEach((line) => {
                const m = line.match(/^(\*?)\s*([a-z-]+):\s*$/);
                if (!m) {
                    return;
                }
                const name = m[2];
                const active = m[1] === "*";
                rows.push({
                    kind: "row",
                    icon: "power-profile-" + name + "-symbolic",
                    label: titleCase(name),
                    action: active ? _("Active") : _("Select"),
                    run: () => {
                        if (active) {
                            return;
                        }
                        GLib.spawn_command_line_async(
                            "powerprofilesctl set " + GLib.shell_quote(name)
                        );
                        this._invalidatePanel("power");
                    },
                });
            });
            if (!rows.length) {
                rows.push({ kind: "note", text: _("No power profiles available") });
            }
            cb(rows);
        });
    }

    /**
     * Builds the Fan Curve panel's rows from fw-fanctrl.
     *
     * @param {Function} cb - Receives row descriptors.
     * @private
     */
    _fetchFan(cb) {
        this._runAll(
            ["fw-fanctrl print list", "fw-fanctrl print current"],
            ([listOut, currentOut]) => {
                const strategies = String(listOut)
                    .split("\n")
                    .map((line) => line.match(/^\s*-\s*(\S+)\s*$/))
                    .filter(Boolean)
                    .map((m) => m[1]);
                const current = (String(currentOut).match(/Strategy in use:\s*'([^']+)'/) || [])[1] || "";

                if (!strategies.length) {
                    cb([{ kind: "note", text: _("fw-fanctrl not responding") }]);
                    return;
                }

                cb(
                    strategies.map((name) => {
                        // medium/agile/very-agile share one curve and differ
                        // only in how fast they react, so say which is which.
                        const reaction = FAN_REACTION[name];
                        return {
                            kind: "row",
                            icon: "weather-windy-symbolic",
                            label: reaction ? name + "  (" + reaction + ")" : name,
                            action: name === current ? _("Active") : _("Select"),
                            run: () => {
                                if (name === current) {
                                    return;
                                }
                                GLib.spawn_command_line_async(
                                    "fw-fanctrl use " + GLib.shell_quote(name)
                                );
                                this._invalidatePanel("fan");
                            },
                        };
                    })
                );
            }
        );
    }

    /**
     * Builds the Wi-Fi panel's rows from nmcli.
     *
     * @param {Function} cb - Receives row descriptors.
     * @private
     */
    _fetchWifi(cb) {
        // SSID goes last so a name containing a colon cannot break the split.
        Util.spawnCommandLineAsyncIO("nmcli -t -f IN-USE,SIGNAL,SSID dev wifi", (stdout) => {
            const best = new Map();
            String(stdout).split("\n").forEach((line) => {
                const parts = line.match(/^([^:]*):([^:]*):(.*)$/);
                if (!parts) {
                    return;
                }
                const ssid = parts[3].replace(/\\:/g, ":").trim();
                if (!ssid) {
                    return; // hidden network, nothing to label it with
                }
                const signal = parseInt(parts[2], 10) || 0;
                const inUse = parts[1].trim() === "*";
                const prev = best.get(ssid);
                // The same SSID appears once per band and per AP; keep the
                // strongest, and let any in-use sighting win.
                best.set(ssid, {
                    ssid: ssid,
                    signal: Math.max(signal, prev ? prev.signal : 0),
                    inUse: inUse || (prev ? prev.inUse : false),
                });
            });

            const networks = Array.from(best.values())
                .sort((a, b) => (b.inUse - a.inUse) || (b.signal - a.signal))
                .slice(0, 6);

            if (!networks.length) {
                cb([{ kind: "note", text: _("No networks found") }]);
                return;
            }

            cb(
                networks.map((net) => ({
                    kind: "row",
                    icon:
                        net.signal > 60
                            ? "network-wireless-signal-excellent-symbolic"
                            : "network-wireless-signal-weak-symbolic",
                    label: net.ssid,
                    action: net.inUse ? _("Disconnect") : _("Connect"),
                    run: () => {
                        const quoted = GLib.shell_quote(net.ssid);
                        GLib.spawn_command_line_async(
                            net.inUse
                                ? "nmcli con down id " + quoted
                                : "nmcli dev wifi connect " + quoted
                        );
                        this.menu.close(true);
                    },
                }))
            );
        });
    }

    /**
     * Builds the Bluetooth panel's rows from bluetoothctl.
     *
     * @param {Function} cb - Receives row descriptors.
     * @private
     */
    _fetchBluetooth(cb) {
        this._runAll(
            ["bluetoothctl devices Paired", "bluetoothctl devices Connected"],
            ([pairedOut, connectedOut]) => {
                const devices = String(pairedOut)
                    .split("\n")
                    .map((line) => line.match(/^Device\s+(\S+)\s+(.*)$/))
                    .filter(Boolean)
                    .map((m) => ({ mac: m[1], name: m[2].trim() }));

                if (!devices.length) {
                    cb([{ kind: "note", text: _("No paired devices") }]);
                    return;
                }

                const connected = new Set(
                    String(connectedOut)
                        .split("\n")
                        .map((line) => (line.match(/^Device\s+(\S+)/) || [])[1])
                        .filter(Boolean)
                );

                cb(
                    devices.map((device) => {
                        const isOn = connected.has(device.mac);
                        return {
                            kind: "row",
                            icon: "bluetooth-symbolic",
                            label: device.name,
                            action: isOn ? _("Disconnect") : _("Connect"),
                            run: () => {
                                GLib.spawn_command_line_async(
                                    "bluetoothctl " +
                                        (isOn ? "disconnect " : "connect ") +
                                        device.mac
                                );
                                this.menu.close(true);
                            },
                        };
                    })
                );
            }
        );
    }

    /**
     * Lays the tile specs out two to a row, dropping any open panel directly
     * beneath the row that owns it.
     *
     * @returns {object} The grid actor.
     * @private
     */
    _buildTileGrid() {
        const specs = this._tileSpecs();
        const grid = new St.BoxLayout({ vertical: true, style: "spacing: 8px;" });
        grid.set_x_expand(true);

        for (let i = 0; i < specs.length; i += 2) {
            const rowSpecs = specs.slice(i, i + 2);
            // Clutter's BoxLayout rather than St's: only the layout manager
            // exposes `homogeneous`, and without it every pill is sized to its
            // own content, so "Do Not Disturb" comes out wider than "Night
            // Light" and the grid never lines up.
            const row = new Clutter.Actor({
                layout_manager: new Clutter.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL,
                    homogeneous: true,
                    spacing: 8,
                }),
                x_expand: true,
            });
            rowSpecs.forEach((spec) => {
                if (spec.expand) {
                    // Panels drop in directly beneath the row that owns them.
                    this.panelSlots[spec.expand] = { host: grid, index: i / 2 + 1 };
                }
                const tile = new QuickTile(spec, this.accent, {
                    onExpand: (key) => this._toggleExpansion(key),
                    onLaunch: (command) => {
                        this.menu.close(true);
                        Util.spawnCommandLine(command);
                    },
                });
                this.tiles[spec.key] = tile;
                row.add_child(tile.actor);
            });
            grid.add_child(row);
        }
        return grid;
    }

    /**
     * The slider stack: volume (with its device chevron), panel backlight,
     * then each DDC/CI monitor's brightness and contrast on a single line.
     *
     * @returns {object} The stack actor.
     * @private
     */
    _buildSliderStack() {
        const box = new St.BoxLayout({ vertical: true, style: "spacing: 4px;" });
        box.set_x_expand(true);

        this.volumeRow = this._sliderRow(
            "audio-volume-high-symbolic",
            (v) => this._setVolume(v),
            "audio"
        );
        box.add_child(this.volumeRow.actor);
        this.panelSlots.audio = { host: box, index: 1 };

        this.panelRow = this._sliderRow("display-brightness-symbolic", (v) => setPanelBrightness(v));
        box.add_child(this.panelRow.actor);

        this.monitors.forEach((monitor) => box.add_child(this._monitorRow(monitor)));

        return box;
    }

    /**
     * Rebuilds the whole popup from scratch.
     */
    updateMenu() {
        this.menu.removeAll();
        this.tiles = {};

        // Trim the stock chrome: .popup-menu-content pads 1em top and bottom,
        // and .popup-menu-item pads 1.75em left and right, which leaves a wide
        // dead margin around a grid like this one.
        this.menu.box.set_style("padding: 8px;");

        const root = new St.BoxLayout({ vertical: true, style: "spacing: 10px;" });
        root.set_x_expand(true);

        root.add_child(this._buildHeader());
        root.add_child(this._buildSliderStack());
        root.add_child(this._buildTileGrid());

        const shell = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
        });
        shell.actor.set_style("padding: 0px;");
        shell.addActor(root, { span: -1, expand: true });
        this.menu.addMenuItem(shell);

        // Slots exist now, so put back whatever panel was open.
        this.panelActor = null;
        this._syncExpansion();

        this.updateStatus();
    }

    /**
     * Detects connected monitors and retrieves their brightness and contrast settings.
     *
     * @param {boolean} [init=true] - Whether the detection is happening on initialization.
     * @returns {Promise<void>} Resolves once the monitors have been read.
     */
    async updateMonitors(init = true) {
        this.detecting = true;
        global.log("Detecting displays...");
        this.monitors = (await getDisplays()).map(
            (d) => new Monitor(d.index, d.name, d.bus)
        );

        if (this.monitors.length === 0) {
            global.log("Could not find any ddc/ci displays.", "warning");
        }

        if (init) {
            this.updateMenu();
        }

        for (const monitor of this.monitors) {
            global.log("Getting brightness of display " + monitor.index + "...");
            await monitor.updateBrightness();
            await monitor.updateContrast();
        }

        this.detecting = false;
        if (!init) {
            this.updateMenu();
        }
    }

    /**
     * Turns Wi-Fi on or off.
     *
     * Async on purpose: spawn_command_line_sync blocks the compositor for as
     * long as nmcli takes, which is visible as a stutter when you flip it.
     *
     * @param {boolean} state - Desired radio state.
     * @private
     */
    _setWifi(state) {
        try {
            GLib.spawn_command_line_async(state ? "nmcli radio wifi on" : "nmcli radio wifi off");
        } catch (e) {
            global.logError("Error toggling Wi-Fi in Quick Settings applet: " + e);
        }
    }

    /**
     * Turns Bluetooth on or off. Async for the same reason as _setWifi.
     *
     * @param {boolean} state - Desired radio state.
     * @private
     */
    _setBluetooth(state) {
        try {
            GLib.spawn_command_line_async(
                state ? "bluetoothctl power on" : "bluetoothctl power off"
            );
        } catch (e) {
            global.logError("Error toggling Bluetooth in Quick Settings applet: " + e);
        }
    }

    /**
     * Airplane mode: every radio nmcli knows about.
     *
     * @param {boolean} state - True to switch the radios off.
     * @private
     */
    _setAirplane(state) {
        try {
            GLib.spawn_command_line_async(state ? "nmcli radio all off" : "nmcli radio all on");
        } catch (e) {
            global.logError("Error toggling airplane mode in Quick Settings applet: " + e);
        }
    }


    /**
     * Sets the default sink volume.
     *
     * pactl rather than Cvc: this only needs a fire-and-forget write on
     * drag-end, and Cvc would mean carrying a live MixerControl and its
     * state-changed handshake for no gain here.
     *
     * @param {number} percent - 0-100.
     * @private
     */
    _setVolume(percent) {
        try {
            GLib.spawn_command_line_async(
                "pactl set-sink-volume @DEFAULT_SINK@ " + Math.max(0, Math.min(100, percent)) + "%"
            );
        } catch (e) {
            global.logError("Error setting volume in Quick Settings applet: " + e);
        }
    }

    /**
     * Refreshes every readout in the popup from the live system state.
     */
    updateStatus() {
        this._refreshBattery();
        this._refreshVolume();
        this._refreshPanelBrightness();
        this._refreshTiles();
        this.monitors.forEach((monitor) => monitor.updateBrightness());
    }

    /**
     * @private
     */
    _refreshBattery() {
        if (!this.batteryLabel) {
            return;
        }
        try {
            const name = this._findBattery();
            if (!name) {
                this.batteryLabel.set_text("--%");
                return;
            }
            const base = "/sys/class/power_supply/" + name + "/";
            const decoder = new TextDecoder();
            const read = (file) => {
                const [ok, contents] = GLib.file_get_contents(base + file);
                // decode(), not String(): file_get_contents hands back a
                // Uint8Array, and stringifying one is the deprecated path GJS
                // warns about on every call.
                return ok ? decoder.decode(contents).trim() : "";
            };
            this.batteryLabel.set_text(read("capacity") + "%");
            if (this.batteryIcon) {
                this.batteryIcon.set_icon_name(
                    read("status") === "Charging"
                        ? "battery-good-charging-symbolic"
                        : "battery-good-symbolic"
                );
            }
        } catch (e) {
            this.batteryLabel.set_text("--%");
        }
    }

    /**
     * Finds the internal battery under /sys/class/power_supply.
     *
     * Not hardcoded to BAT0: this machine's pack is BAT1, and the directory
     * also carries hidpp_battery_0 for a paired Logitech device, which reports
     * its own charge and would otherwise be shown as the laptop's.
     *
     * @returns {string|null} Device directory name, or null if none.
     * @private
     */
    _findBattery() {
        try {
            const iter = Gio.File.new_for_path("/sys/class/power_supply")
                .enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null)) !== null) {
                if (/^BAT/i.test(info.get_name())) {
                    return info.get_name();
                }
            }
        } catch (e) {
            global.logError("Quick Settings: battery lookup failed: " + e);
        }
        return null;
    }

    /**
     * @private
     */
    _refreshVolume() {
        if (!this.volumeRow) {
            return;
        }
        Util.spawnCommandLineAsyncIO(
            "pactl get-sink-volume @DEFAULT_SINK@",
            (stdout) => {
                const match = String(stdout).match(/(\d+)%/);
                if (match && this.volumeRow) {
                    this.volumeRow.slider.setValue(Math.min(100, parseInt(match[1], 10)) / 100);
                }
            }
        );
    }

    /**
     * @private
     */
    _refreshPanelBrightness() {
        getPanelBrightness((percent) => {
            if (percent !== null && this.panelRow) {
                this.panelRow.slider.setValue(percent / 100);
            }
        });
    }

    /**
     * Pushes live state onto every tile.
     *
     * @private
     */
    _refreshTiles() {
        const tile = (key) => this.tiles[key];

        if (tile("wifi")) {
            Util.spawnCommandLineAsyncIO("nmcli radio wifi", (stdout) => {
                const on = String(stdout).trim() === "enabled";
                if (tile("wifi")) {
                    tile("wifi").setActive(on);
                }
                if (tile("airplane")) {
                    tile("airplane").setActive(!on);
                }
            });
            Util.spawnCommandLineAsyncIO(
                "nmcli -t -f active,ssid dev wifi",
                (stdout) => {
                    const line = String(stdout)
                        .split("\n")
                        .find((l) => l.startsWith("yes:"));
                    if (tile("wifi")) {
                        tile("wifi").setSubtitle(line ? line.slice(4) : "");
                    }
                }
            );
        }

        if (tile("bluetooth")) {
            Util.spawnCommandLineAsyncIO("bluetoothctl show", (stdout) => {
                if (tile("bluetooth")) {
                    tile("bluetooth").setActive(String(stdout).includes("Powered: yes"));
                }
            });
        }

        if (tile("power")) {
            Util.spawnCommandLineAsyncIO("powerprofilesctl get", (out) => {
                const name = String(out).trim();
                if (tile("power") && name) {
                    tile("power").setSubtitle(titleCase(name));
                    tile("power").setIcon("power-profile-" + name + "-symbolic");
                    // Performance is the one profile worth flagging at a glance.
                    tile("power").setActive(name === "performance");
                }
            });
        }

        if (tile("fan")) {
            this._runAll(
                ["fw-fanctrl print current", "fw-fanctrl print speed"],
                ([current, speed]) => {
                    if (!tile("fan")) {
                        return;
                    }
                    const strategy = (current.match(/Strategy in use:\s*'([^']+)'/) || [])[1] || "";
                    const duty = (speed.match(/'(\d+%)'/) || [])[1] || "";
                    tile("fan").setSubtitle([strategy, duty].filter(Boolean).join("  \u00b7  "));
                }
            );
        }

        if (tile("nightlight")) {
            tile("nightlight").setActive(
                getBool("org.cinnamon.settings-daemon.plugins.color", "night-light-enabled", false)
            );
        }
    }

    /**
     * Handles the applet click event, updating the status and toggling the menu visibility.
     */
    on_applet_clicked() {
        this.updateStatus();
        this.menu.toggle();
        if (this.menu.isOpen) {
            this._prefetchPanels();
        }
    }

    /**
     * Handles the applet being added to the panel, initializing monitor detection.
     */
    on_applet_added_to_panel() {
        if (!this.detecting) {
            this.updateMonitors();
        }
    }

    /**
     * Handles scroll events on the applet, adjusting the brightness of the connected monitors.
     *
     * @param {object} actor - The actor receiving the scroll event.
     * @param {object} event - The scroll event object.
     * @private
     */
    _onScrollEvent(actor, event) {
        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.SMOOTH) {
            return;
        }

        clearTimeout(this.lastTooltipTimeoutID);
        let adjustment = (direction == Clutter.ScrollDirection.UP) ? BRIGHTNESS_ADJUSTMENT_STEP : -BRIGHTNESS_ADJUSTMENT_STEP;
        let tooltipMessage = this.monitors.map(monitor => {
            monitor.brightness = Math.min(100, Math.max(0, monitor.brightness + adjustment));
            monitor.setBrightness(monitor.brightness);
            return `${monitor.name}: ${monitor.brightness}%`;
        }).join("\n");

        this.set_applet_tooltip(tooltipMessage);
        this._applet_tooltip.show();
        this.lastTooltipTimeoutID = setTimeout(() => {
            this._applet_tooltip.hide();
            this.set_applet_tooltip(DEFAULT_TOOLTIP);
        }, 2500);
    }
}

/**
 * Asynchronously detects connected displays using the `ddcutil detect` command and parses the output
 * to retrieve the display index, bus number, and model name.
 * 
 * @returns {Promise<Array<object>>} A promise that resolves with an array of display objects.
 * Each display object contains the following properties:
 *   - {number} index - The display index.
 *   - {string} name - The display name, typically the model name.
 *   - {number} bus - The I2C bus number used to communicate with the display.
 * 
 * @throws {Error} If the `ddcutil detect` command fails, logs the error and shows a notification dialog.
 */
async function getDisplays() {
    const ddcutilOutput = await new Promise((resolve, reject) => {
        Util.spawnCommandLineAsyncIO(
            `ddcutil detect`,
            (stdout, stderr, exitCode) => {
                if (exitCode == 0) {
                    resolve(stdout); // Command successful, resolve with output
                } else {
                    // Log the error and show a notification dialog for failure
                    global.logError("Failed to detect displays: " + stderr);
                    const dialog = new ModalDialog.NotifyDialog([
                        "Failed to detect displays.",
                        "Make sure you have ddcutil installed and the correct permissions.",
                        "Error: " + stderr
                    ].join("\n"));
                    dialog.open();
                    reject(stderr);
                }
            }
        );
    });

    let displays = []; // Array to store detected displays
    const lines = ddcutilOutput.split("\n");
    let currentDisplay = null;

    // Parse the output from ddcutil to extract display information
    for (const line of lines) {
        const displayMR = line.match(/^Display (\d+)$/); // Match for display index

        if (displayMR && displayMR.length === 2) {
            const index = parseInt(displayMR[1], 10); // Extract display index

            // If a display was being processed, complete its info and push it to the list
            if (currentDisplay) {
                if (currentDisplay.name === undefined) {
                    currentDisplay.name = currentDisplay.fallbackName;
                }
                displays.push(currentDisplay);
            }

            // Start processing a new display
            currentDisplay = {
                index,
                fallbackName: displayMR[0], // Use fallback name if model is unavailable
            };
        } else {
            // Continue processing the current display
            if (currentDisplay) {
                // Match for I2C bus number
                const busMR = line.match(/^\s+I2C bus:\s+\/dev\/i2c-(\d+)$/);

                if (busMR && busMR.length === 2 && currentDisplay.bus === undefined) {
                    currentDisplay.bus = parseInt(busMR[1], 10); // Extract and assign the bus number
                } else {
                    // Match for model name
                    const modelMR = line.match(/^\s+Model:\s+(.+)$/);

                    if (modelMR && modelMR.length === 2 && currentDisplay.name === undefined) {
                        currentDisplay.name = modelMR[1]; // Assign the model name if available
                    }
                }
            } else {
                continue; // Skip lines if no current display is being processed
            }
        }
    }

    // Finalize the last detected display and add it to the list
    if (currentDisplay) {
        if (currentDisplay.name === undefined) {
            currentDisplay.name = currentDisplay.fallbackName;
        }
        displays.push(currentDisplay);
    }

    global.log(`Detected ${displays.length} displays.`); // Log the number of detected displays
    return displays;
}

/**
 * Entry point function that creates and returns a new instance of the QuickSettingsApplet.
 *
 * @param {object} metadata - Metadata about the applet.
 * @param {string} orientation - The orientation of the applet within the panel.
 * @param {number} panel_height - The height of the panel.
 * @param {number} instance_id - A unique instance identifier for the applet.
 * 
 * @returns {QuickSettingsApplet} A new instance of the QuickSettingsApplet.
 */
function main(metadata, orientation, panel_height, instance_id) {
    const applet = new QuickSettingsApplet(metadata, orientation, panel_height, instance_id);
    return applet;
}
