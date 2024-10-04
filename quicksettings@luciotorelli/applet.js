const Applet = imports.ui.applet;
const Lang = imports.lang;
const St = imports.gi.St;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;  
const ModalDialog = imports.ui.modalDialog; 
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const ByteArray = imports.byteArray;

const DEFAULT_TOOLTIP = "Quick Settings";
const BRIGHTNESS_ADJUSTMENT_STEP = 5; 

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
     * Updates the label in the UI to reflect the current brightness value.
     */
    updateLabel() {
        if (this.menuLabel) {
            this.menuLabel.setLabel(`${this.name}  (${this.brightness}%)`);
        }
    }

    /**
     * Updates the monitor's menu with the current brightness and contrast values.
     */
    updateMenu() {
        this.updateLabel(); // Update label for brightness
        if (this.menuSlider) {
            this.menuSlider.setValue(this.brightness / 100); // Set slider to current brightness value
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
     * Adds the monitor's brightness and contrast controls to the applet's popup menu.
     * 
     * @param {object} menu - The menu to which the monitor's controls will be added.
     */
    addToMenu(menu) {
        // Label for the monitor
        const menuLabel = new PopupMenu.PopupMenuItem(this.name, {
            reactive: false,
        });
        this.menuLabel = menuLabel;
        menu.addMenuItem(menuLabel);

        // Brightness Slider
        const menuSlider = new PopupMenu.PopupSliderMenuItem(this.brightness / 100);
        this.menuSlider = menuSlider;
        menuSlider.connect("value-changed", (slider) => {
            const brightness = Math.round(100 * slider.value);
            this.brightness = brightness;
            this.updateLabel(); // Update label to show new brightness value
        });

        menuSlider.connect("drag-end", (slider) => {
            const brightness = Math.round(100 * slider.value);
            this.setBrightness(brightness); // Set new brightness after dragging ends
        });

        menu.addMenuItem(menuSlider);

        // Contrast Label and Slider
        const contrastLabel = new PopupMenu.PopupMenuItem(this.name + " Contrast", {
            reactive: false,
        });
        menu.addMenuItem(contrastLabel);

        const contrastSlider = new PopupMenu.PopupSliderMenuItem(this.contrast / 100);
        menu.addMenuItem(contrastSlider);

        contrastSlider.connect("value-changed", (slider) => {
            const contrast = Math.round(100 * slider.value);
            this.contrast = contrast;
            contrastLabel.setLabel(`${this.name} Contrast (${contrast}%)`); // Update label to show new contrast value
        });

        contrastSlider.connect("drag-end", (slider) => {
            const contrast = Math.round(100 * slider.value);
            this.setContrast(contrast); // Set new contrast after dragging ends
        });
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
     * Adds the basic items (Wi-Fi and Bluetooth) to the applet's popup menu.
     * Also initializes the detection of connected monitors.
     *
     * @private
     */
    _addMenuItems() {
        let hbox = new St.BoxLayout({ vertical: false });

        // Wi-Fi toggle switch
        this.wifiSwitch = new PopupMenu.PopupSwitchIconMenuItem(_("Wi-Fi"), false, "network-wireless-symbolic", St.IconType.SYMBOLIC);
        this.wifiSwitch.connect('toggled', Lang.bind(this, this._toggleWifi));
        hbox.add_child(this.wifiSwitch.actor);

        // Bluetooth toggle switch
        this.bluetoothSwitch = new PopupMenu.PopupSwitchIconMenuItem(_("Bluetooth"), false, "bluetooth-symbolic", St.IconType.SYMBOLIC);
        this.bluetoothSwitch.connect('toggled', Lang.bind(this, this._toggleBluetooth));
        hbox.add_child(this.bluetoothSwitch.actor);

        // Add the toggle switches to the menu
        this.menu.addActor(hbox);

        // Detect and display monitor settings
        this.updateMonitors();
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
     * Updates the applet's popup menu with the detected monitor brightness and contrast
     */
    updateMenu() {
        // Clear existing menu items
        this.menu.removeAll();

        // Add Wi-Fi and Bluetooth switches
        let hbox = new St.BoxLayout({ vertical: false });
        hbox.add_child(this.wifiSwitch.actor);
        hbox.add_child(this.bluetoothSwitch.actor);
        this.menu.addActor(hbox);

        // Add a separator between switches and monitor sliders 
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Add each monitor's brightness and contrast controls to the menu
        this.monitors.forEach((monitor) => {
            monitor.addToMenu(this.menu);
        });

        // Add a "refresh displays" button to refresh the list of monitors
        let reload = new PopupMenu.PopupImageMenuItem(
            "Refresh Displays",
            "emblem-synchronizing-symbolic",
            St.IconType.SYMBOLIC,
            {
                reactive: true,
            }
        );

        this.menu.addMenuItem(reload);

        // Re-detect displays when the button is clicked
        reload.connect("activate", () => {
            if (!this.detecting) {
                const infoOSD = new ModalDialog.InfoOSD("Detecting displays...");
                infoOSD.show();
                reload.destroy();
                this.updateMonitors().then(
                    () => this.menu.open(true),
                    e  => global.logError("Error: "  + e)
                ).then(() => infoOSD.destroy());
            }
        });

        // Add a separator between monitor settings and other items 
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    /**
     * Toggles the Wi-Fi state on or off based on the switch position.
     *
     * @param {object} switchItem - The switch element that triggered the toggle.
     * @private
     */
    _toggleWifi(switchItem) {
        try {
            let command = switchItem.state ? 'nmcli radio wifi on' : 'nmcli radio wifi off';
            // Execute Wi-Fi toggle command
            GLib.spawn_command_line_sync(command);
        } catch (e) {
            global.logError("Error toggling Wi-Fi in Quick Settings applet: " + e);
        }
    }

    /**
     * Toggles the Bluetooth state on or off based on the switch position.
     *
     * @param {object} switchItem - The switch element that triggered the toggle.
     * @private
     */
    _toggleBluetooth(switchItem) {
        try {
            let command = switchItem.state ? 'bluetoothctl power on' : 'bluetoothctl power off';
            // Execute Bluetooth toggle command
            GLib.spawn_command_line_sync(command);
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
            let [result, stdout, stderr] = GLib.spawn_command_line_sync('nmcli radio wifi');
            this.wifiSwitch.setToggleState(stdout.toString().trim() === 'enabled');
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
            let [result, stdout, stderr] = GLib.spawn_command_line_sync('bluetoothctl show');
            let output = stdout.toString();
            this.bluetoothSwitch.setToggleState(output.includes('Powered: yes'));
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
