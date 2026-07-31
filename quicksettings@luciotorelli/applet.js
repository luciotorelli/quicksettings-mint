const Applet = imports.ui.applet;
const St = imports.gi.St;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;  
const ModalDialog = imports.ui.modalDialog; 
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;

const DEFAULT_TOOLTIP = "Quick Settings";
const BRIGHTNESS_ADJUSTMENT_STEP = 5;

// Tile geometry, shared by the quick toggles so they line up.
const TILE_RADIUS = 14;
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
 * QuickSettingsApplet is a custom Cinnamon applet that provides quick access to monitor settings 
 * (brightness and contrast), Wi-Fi, and Bluetooth. It also detects connected displays.
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
        this.set_applet_tooltip(DEFAULT_TOOLTIP); // Tooltip for the applet
        this.actor.connect('scroll-event', (...args) => this._onScrollEvent(...args)); // Scroll event handler for brightness adjustment
        this.lastTooltipTimeoutID = null;
        this.monitors = [];

        // Initialize the applet's popup menu
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this._addMenuItems(); // Add menu items such as Wi-Fi and Bluetooth
        this.updateStatus(); // Update the applet's status for monitors, Wi-Fi, and Bluetooth
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
     * Builds a Control-Centre style tile with a split click target.
     *
     * The body - icon and label - opens the relevant settings app. The switch
     * on the right toggles the radio and nothing else. So hitting the toggle
     * never navigates away, and hitting the label never flips your Wi-Fi off,
     * which is the behaviour the gear-icon version could not express.
     *
     * @param {object} spec - Tile definition.
     * @param {string} spec.icon - Symbolic icon name shown in the body.
     * @param {string} spec.label - Caption shown beside the icon.
     * @param {Function} spec.onOpen - Run when the body is clicked.
     * @param {Function} spec.onToggle - Run with the new boolean state.
     * @returns {object} `{ actor, toggle }`; toggle exposes setToggleState().
     * @private
     */
    _makeToggleTile({ icon, label, onOpen, onToggle }) {
        const tile = new St.BoxLayout({ vertical: false, reactive: true });
        tile.set_x_expand(true);

        const paint = (hovered) =>
            tile.set_style(
                "padding: 8px 10px; spacing: 8px; transition-duration: 150;" +
                "border-radius: " + TILE_RADIUS + "px;" +
                "background-color: " + (hovered ? TILE_HOVER : TILE_IDLE) + ";"
            );
        paint(false);
        tile.connect("enter-event", () => paint(true));
        tile.connect("leave-event", () => paint(false));

        // Body: everything except the switch opens settings.
        const bodyBox = new St.BoxLayout({ vertical: false, style: "spacing: 8px;" });
        bodyBox.add_child(
            new St.Icon({
                icon_name: icon,
                icon_type: St.IconType.SYMBOLIC,
                icon_size: 18,
            })
        );
        bodyBox.add_child(
            new St.Label({ text: label, y_align: Clutter.ActorAlign.CENTER })
        );

        const body = new St.Button({ child: bodyBox, x_expand: true });
        body.set_style("background-color: transparent; border: none; padding: 0px;");
        body.connect("clicked", () => {
            this.menu.close(true);
            onOpen();
        });
        tile.add_child(body);

        // Switch: toggles, and does not open anything.
        const toggle = new PopupMenu.Switch(false);
        const toggleButton = new St.Button({ child: toggle.actor });
        toggleButton.set_style("background-color: transparent; border: none; padding: 0px;");
        toggleButton.connect("clicked", () => {
            toggle.toggle();
            onToggle(toggle.state);
        });
        tile.add_child(toggleButton);

        return { actor: tile, toggle };
    }
    
        

    /**
     * Detects connected monitors and retrieves their brightness and contrast settings.
     *
     * @param {boolean} [init=true] - Whether the detection is happening on initialization.
     * @returns {Promise<void>} A promise that resolves when the monitors have been detected and their settings fetched.
     */
    async updateMonitors(init = true) {
        this.detecting = true;
        global.log("Detecting displays...");
        this.monitors = (await getDisplays()).map(
            // Create a Monitor object for each display detected
            (d) => new Monitor(d.index, d.name, d.bus)
        );

        if (this.monitors.length === 0) {
            global.log("Could not find any ddc/ci displays.", "warning");
        }

        if (init) {
            // Update the applet menu after initial detection
            this.updateMenu();
        }

        // Get brightness and contrast for each monitor
        for (const monitor of this.monitors) {
            global.log(`Getting brightness of display ${monitor.index}...`);
            await monitor.updateBrightness();
            await monitor.updateContrast();
        }

        this.detecting = false;
        if (!init) {
            // Update menu after detection is complete
            this.updateMenu();
        }
    }

    /**
     * Rebuilds the popup from scratch: quick toggles, then any displays.
     *
     * Everything is recreated here rather than stashed and re-parented. The
     * previous version kept the switch actors alive across removeAll() and
     * added them to a fresh box each time, which only worked by accident -
     * an actor that still has a parent cannot be added to another one.
     */
    updateMenu() {
        this.menu.removeAll();

        const wifi = this._makeToggleTile({
            icon: "network-wireless-symbolic",
            label: _("Wi-Fi"),
            onOpen: () => Util.spawnCommandLine("cinnamon-settings network"),
            onToggle: (state) => this._setWifi(state),
        });

        const bluetooth = this._makeToggleTile({
            icon: "bluetooth-symbolic",
            label: _("Bluetooth"),
            onOpen: () => Util.spawnCommandLine("blueman-manager"),
            onToggle: (state) => this._setBluetooth(state),
        });

        this.wifiSwitch = wifi.toggle;
        this.bluetoothSwitch = bluetooth.toggle;

        const tiles = new St.BoxLayout({ vertical: false, style: "spacing: 10px;" });
        tiles.set_x_expand(true);
        tiles.add_child(wifi.actor);
        tiles.add_child(bluetooth.actor);

        const tileRow = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
        });
        tileRow.addActor(tiles, { span: -1, expand: true });
        this.menu.addMenuItem(tileRow);

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

        // Re-detect displays when the button is clicked. init=false so the menu
        // is rebuilt once the brightness/contrast reads have landed, rather
        // than immediately with placeholder values.
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

        // The switches were just recreated, so push the live radio state onto them.
        this.updateStatus();
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
     * Updates the Wi-Fi switch to reflect the current Wi-Fi state (on/off).
     *
     * @private
     */
    _updateWifiSwitchState() {
        try {
            // Async, and it hands back a string. The sync variant returned a
            // Uint8Array whose .toString() GJS now warns about on every call.
            Util.spawnCommandLineAsyncIO("nmcli radio wifi", (stdout) => {
                if (this.wifiSwitch) {
                    this.wifiSwitch.setToggleState(String(stdout).trim() === "enabled");
                }
            });
        } catch (e) {
            global.logError("Error updating Wi-Fi switch state in Quick Settings applet: " + e);
        }
    }

    /**
     * Updates the Bluetooth switch to reflect the current Bluetooth state (on/off).
     *
     * @private
     */
    _updateBluetoothSwitchState() {
        try {
            Util.spawnCommandLineAsyncIO("bluetoothctl show", (stdout) => {
                if (this.bluetoothSwitch) {
                    this.bluetoothSwitch.setToggleState(String(stdout).includes("Powered: yes"));
                }
            });
        } catch (e) {
            global.logError("Error updating Bluetooth switch state in Quick Settings applet: " + e);
        }
    }

    /**
     * Updates the status of Wi-Fi, Bluetooth, and monitors in the applet.
     */    
    updateStatus() {
        this._updateWifiSwitchState();
        this._updateBluetoothSwitchState();
        this.monitors.forEach((monitor) => {
            monitor.updateBrightness();
        });
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
        if(!this.detecting) {
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
