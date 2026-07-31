const Applet = imports.ui.applet;
const St = imports.gi.St;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;  
const ModalDialog = imports.ui.modalDialog; 
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

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
const ACCENT_FALLBACK = "#ff7139";

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
        if (this.menuLabel) {
            this.menuLabel.setLabel(this.name);
        }
        if (this.brightnessLabel) {
            this.brightnessLabel.set_text(`Brightness (${this.brightness}%)`);
        }
        if (this.contrastLabel) {
            this.contrastLabel.set_text(`Contrast (${this.contrast}%)`);
        }
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

    /**
     * Builds one labelled slider, sized to sit alongside another on one line.
     *
     * @param {string} title - The caption above the slider ("Brightness").
     * @param {number} initial - Starting value, 0-100.
     * @param {Function} onPreview - Called with the live value while dragging.
     * @param {Function} onCommit - Called with the final value on drag-end.
     * @returns {object} `{ actor, label, slider }` for the caller to place.
     * @private
     */
    _buildSliderColumn(title, initial, accent, onPreview, onCommit) {
        const column = new St.BoxLayout({ vertical: true });
        column.set_x_expand(true);

        const label = new St.Label({ text: `${title} (${initial}%)` });
        label.set_style("font-size: 0.9em; padding-left: 2px;");
        column.add_child(label);

        const slider = new PopupMenu.PopupSliderMenuItem(initial / 100);
        // The stock .popup-slider-menu-item is min-width: 15em. Two of those on
        // one line would force a ~30em popup, so halve it - the pair then fits
        // in roughly the width the single stacked slider used to take.
        //
        // The track is also a 0.3em hairline by default. Thickening it and
        // growing the handle is what reads as "modern" without custom Cairo
        // drawing; these are the theme's own St properties, just overridden.
        slider._slider.set_style(
            "min-width: 7em;" +
            "-slider-height: 0.5em;" +
            "-slider-handle-radius: 0.55em;" +
            `-slider-active-background-color: ${accent};` +
            "-slider-background-color: rgba(255,255,255,0.12);"
        );
        // The slider is a menu item in its own right, so it arrives with the
        // popup-menu-item padding already applied. Nested inside this row that
        // padding is doubled up; drop it.
        slider.actor.set_style("padding: 0px;");
        slider.actor.set_x_expand(true);

        slider.connect("value-changed", (s) => onPreview(Math.round(100 * s.value)));
        slider.connect("drag-end", (s) => onCommit(Math.round(100 * s.value)));

        column.add_child(slider.actor);
        return { actor: column, label, slider };
    }

    /**
     * Adds the monitor's brightness and contrast controls to the applet's popup menu.
     *
     * The two sliders share a single horizontal line - brightness on the left,
     * contrast on the right - under a heading carrying the monitor's name.
     *
     * @param {object} menu - The menu to which the monitor's controls will be added.
     * @param {string} accent - The theme accent colour for the slider fill.
     */
    addToMenu(menu, accent) {
        // Monitor name, on its own line above the pair.
        this.menuLabel = new PopupMenu.PopupMenuItem(this.name, {
            reactive: false,
        });
        menu.addMenuItem(this.menuLabel);

        const brightness = this._buildSliderColumn(
            "Brightness",
            this.brightness,
            accent,
            (value) => {
                this.brightness = value;
                this.updateLabel(); // Live readout while the handle is moving
            },
            (value) => this.setBrightness(value)
        );

        const contrast = this._buildSliderColumn(
            "Contrast",
            this.contrast,
            accent,
            (value) => {
                this.contrast = value;
                this.updateLabel();
            },
            (value) => this.setContrast(value)
        );

        this.brightnessLabel = brightness.label;
        this.menuSlider = brightness.slider;
        this.contrastLabel = contrast.label;
        this.contrastSlider = contrast.slider;

        // One row holding both columns side by side.
        const row = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
        });

        const hbox = new St.BoxLayout({ vertical: false, style: "spacing: 16px;" });
        hbox.set_x_expand(true);
        hbox.add_child(brightness.actor);
        hbox.add_child(contrast.actor);

        // span: -1 gives the box the full width of the row rather than one
        // column of the menu item's internal column layout.
        row.addActor(hbox, { span: -1, expand: true });
        menu.addMenuItem(row);

        this.updateLabel();
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
 * Two click targets in one rounded tile: the body and, where the spec supplies
 * an onOpen, a chevron behind a hairline divider. Which half does what is
 * decided by BODY_TOGGLES.
 */
class QuickTile {
    /**
     * @param {object} spec - Tile definition (icon, title, onToggle, onOpen).
     * @param {string} accent - Theme accent used for the active state.
     * @param {object} menu - Popup menu, closed before launching anything.
     */
    constructor(spec, accent, menu) {
        this.spec = spec;
        this.accent = accent;
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
        this.subtitleLabel.hide();
        text.add_child(this.subtitleLabel);
        inner.add_child(text);

        const toggleAction = () => {
            this.setActive(!this.active);
            spec.onToggle(this.active);
        };
        const openAction = spec.onOpen
            ? () => {
                  menu.close(true);
                  spec.onOpen();
              }
            : null;

        this.body = new St.Button({ child: inner, x_expand: true });
        this.body.set_style("background-color: transparent; border: none; padding: 0px;");
        this.body.connect(
            "clicked",
            BODY_TOGGLES || !openAction ? toggleAction : openAction
        );
        this.actor.add_child(this.body);

        if (openAction) {
            this.chevron = new St.Button({
                child: new St.Icon({
                    icon_name: "go-next-symbolic",
                    icon_type: St.IconType.SYMBOLIC,
                    icon_size: 14,
                }),
            });
            this.chevron.connect("clicked", BODY_TOGGLES ? openAction : toggleAction);
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

        this.actor.set_style(
            "padding: 10px 14px; spacing: 8px; transition-duration: 150;" +
            "border-radius: " + TILE_PILL_RADIUS + "px;" +
            "background-color: " + background + ";"
        );

        // Only force a colour while active. Clearing it otherwise lets the
        // theme decide, so this still reads correctly on a light theme.
        if (this.active) {
            this.titleLabel.set_style("font-weight: bold; color: #ffffff;");
            this.subtitleLabel.set_style("font-size: 0.8em; color: rgba(255,255,255,0.8);");
            this.icon.set_style("color: #ffffff;");
        } else {
            this.titleLabel.set_style("font-weight: bold;");
            this.subtitleLabel.set_style("font-size: 0.8em;");
            this.icon.set_style(null);
        }

        if (this.chevron) {
            this.chevron.set_style(
                "background-color: transparent; padding: 0px 2px 0px 10px; margin-left: 6px;" +
                "border-left: 1px solid " +
                (this.active ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.18)") +
                ";"
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
     * A dim uppercase caption used to group the popup into sections.
     *
     * @param {string} text - The heading text.
     * @returns {object} A non-interactive menu item.
     * @private
     */
    _sectionHeader(text) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
        });
        const label = new St.Label({ text: text.toUpperCase() });
        label.set_style(
            "font-size: 0.72em; font-weight: bold; padding: 2px;" +
            "color: rgba(255,255,255,0.45);"
        );
        item.addActor(label, { span: -1 });
        return item;
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
     * One full-width slider with a leading icon.
     *
     * @param {string} iconName - Symbolic icon name.
     * @param {Function} onCommit - Called with 0-100 on drag-end.
     * @returns {object} `{ actor, slider }`.
     * @private
     */
    _sliderRow(iconName, onCommit) {
        const row = new St.BoxLayout({ vertical: false, style: "spacing: 12px; padding: 2px 6px;" });
        row.set_x_expand(true);
        row.add_child(
            new St.Icon({
                icon_name: iconName,
                icon_type: St.IconType.SYMBOLIC,
                icon_size: 18,
            })
        );

        const slider = new PopupMenu.PopupSliderMenuItem(0);
        slider._slider.set_style(
            "min-width: 16em;" +
            "-slider-height: 0.5em;" +
            "-slider-handle-radius: 0.55em;" +
            "-slider-active-background-color: " + this.accent + ";" +
            "-slider-background-color: rgba(255,255,255,0.12);"
        );
        slider.actor.set_style("padding: 0px;");
        slider.actor.set_x_expand(true);
        // Commit on drag-end only. Firing on value-changed would spawn a
        // process per motion event.
        slider.connect("drag-end", (s) => onCommit(Math.round(100 * s.value)));
        row.add_child(slider.actor);

        return { actor: row, slider };
    }

    /**
     * The toggle pills, in the order they appear in the grid.
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
                onToggle: (state) => this._setWifi(state),
                onOpen: () => Util.spawnCommandLine("cinnamon-settings network"),
            },
            {
                key: "bluetooth",
                icon: "bluetooth-symbolic",
                title: _("Bluetooth"),
                onToggle: (state) => this._setBluetooth(state),
                onOpen: () => Util.spawnCommandLine("blueman-manager"),
            },
            {
                key: "nightlight",
                icon: "night-light-symbolic",
                title: _("Night Light"),
                onToggle: (state) =>
                    setBool("org.cinnamon.settings-daemon.plugins.color", "night-light-enabled", state),
                onOpen: () => Util.spawnCommandLine("cinnamon-settings nightlight"),
            },
            {
                key: "dnd",
                icon: "notifications-disabled-symbolic",
                title: _("Do Not Disturb"),
                // The key stores the inverse: notifications ON means DND OFF.
                onToggle: (state) =>
                    setBool("org.cinnamon.desktop.notifications", "display-notifications", !state),
            },
            {
                key: "dark",
                icon: "weather-clear-night-symbolic",
                title: _("Dark Style"),
                onToggle: (state) => this._setDarkStyle(state),
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
     * Lays the tile specs out two to a row.
     *
     * @returns {object} The grid actor.
     * @private
     */
    _buildTileGrid() {
        const specs = this._tileSpecs();
        const grid = new St.BoxLayout({ vertical: true, style: "spacing: 8px;" });
        grid.set_x_expand(true);

        for (let i = 0; i < specs.length; i += 2) {
            const row = new St.BoxLayout({ vertical: false, style: "spacing: 8px;" });
            row.set_x_expand(true);
            specs.slice(i, i + 2).forEach((spec) => {
                const tile = new QuickTile(spec, this.accent, this.menu);
                this.tiles[spec.key] = tile;
                row.add_child(tile.actor);
            });
            grid.add_child(row);
        }
        return grid;
    }

    /**
     * Rebuilds the whole popup from scratch.
     */
    updateMenu() {
        this.menu.removeAll();
        this.tiles = {};

        const root = new St.BoxLayout({ vertical: true, style: "spacing: 12px; padding: 6px 8px;" });
        root.set_x_expand(true);

        root.add_child(this._buildHeader());

        const sliders = new St.BoxLayout({ vertical: true, style: "spacing: 8px;" });
        sliders.set_x_expand(true);
        this.volumeRow = this._sliderRow("audio-volume-high-symbolic", (v) => this._setVolume(v));
        this.panelRow = this._sliderRow("display-brightness-symbolic", (v) => setPanelBrightness(v));
        sliders.add_child(this.volumeRow.actor);
        sliders.add_child(this.panelRow.actor);
        root.add_child(sliders);

        root.add_child(this._buildTileGrid());

        const shell = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
        });
        shell.addActor(root, { span: -1, expand: true });
        this.menu.addMenuItem(shell);

        // DDC/CI monitors keep their own section below the grid.
        if (this.monitors.length > 0) {
            this.menu.addMenuItem(this._sectionHeader("Displays"));
            this.monitors.forEach((monitor) => monitor.addToMenu(this.menu, this.accent));
        }

        const reload = new PopupMenu.PopupImageMenuItem(
            "Refresh Displays",
            "emblem-synchronizing-symbolic",
            St.IconType.SYMBOLIC,
            {
                reactive: true,
            }
        );
        this.menu.addMenuItem(reload);
        reload.connect("activate", () => {
            if (!this.detecting) {
                const infoOSD = new ModalDialog.InfoOSD("Detecting displays...");
                infoOSD.show();
                this.updateMonitors(false).then(
                    () => this.menu.open(true),
                    (e) => global.logError("Error: " + e)
                ).then(() => infoOSD.destroy());
            }
        });

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
     * Swaps the GTK and Cinnamon themes between their light and dark variants.
     *
     * Mint ships these as name pairs - Mint-Y-Orange and Mint-Y-Dark-Orange -
     * so this rewrites the name rather than hardcoding a theme. A name that
     * does not match the pattern is left alone, which fails safe.
     *
     * @param {boolean} dark - True for the dark variant.
     * @private
     */
    _setDarkStyle(dark) {
        const convert = (name) =>
            dark
                ? name.includes("-Dark")
                    ? name
                    : name.replace(/^(Mint-[A-Za-z0-9]+)/, "$1-Dark")
                : name.replace("-Dark", "");
        try {
            const iface = new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" });
            iface.set_string("gtk-theme", convert(iface.get_string("gtk-theme")));
            const theme = new Gio.Settings({ schema_id: "org.cinnamon.theme" });
            theme.set_string("name", convert(theme.get_string("name")));
        } catch (e) {
            global.logError("Error switching dark style in Quick Settings applet: " + e);
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
            const read = (file) => {
                const [ok, contents] = GLib.file_get_contents(base + file);
                return ok ? String(contents).trim() : "";
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

        if (tile("nightlight")) {
            tile("nightlight").setActive(
                getBool("org.cinnamon.settings-daemon.plugins.color", "night-light-enabled", false)
            );
        }
        if (tile("dnd")) {
            tile("dnd").setActive(
                !getBool("org.cinnamon.desktop.notifications", "display-notifications", true)
            );
        }
        if (tile("dark")) {
            try {
                const name = new Gio.Settings({
                    schema_id: "org.cinnamon.desktop.interface",
                }).get_string("gtk-theme");
                tile("dark").setActive(name.includes("-Dark"));
            } catch (e) {
                // leave it as-is
            }
        }
    }

    /**
     * Handles the applet click event, updating the status and toggling the menu visibility.
     */
    on_applet_clicked() {
        this.updateStatus();
        this.menu.toggle();
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
