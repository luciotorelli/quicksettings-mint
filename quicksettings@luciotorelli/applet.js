const Applet = imports.ui.applet;
const St = imports.gi.St;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;
const DEFAULT_TOOLTIP = "Quick Settings";
const BRIGHTNESS_ADJUSTMENT_STEP = 5;

/**
 * QuickSettingsApplet provides quick access to Wi-Fi, Bluetooth, and monitor settings.
 */
class QuickSettingsApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.set_applet_icon_symbolic_name("preferences-system");
        this.set_applet_tooltip(DEFAULT_TOOLTIP);
        this.monitors = [];
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._addMenuItems();
        this.updateStatus();
    }

    _addMenuItems() {
        let hbox = new St.BoxLayout();
        this.wifiSwitch = this._addSwitchWithIcon(hbox, "Wi-Fi", "network-wireless-symbolic", this._toggleWifi, "cinnamon-settings network");
        this.bluetoothSwitch = this._addSwitchWithIcon(hbox, "Bluetooth", "bluetooth-symbolic", this._toggleBluetooth, "blueman-manager");
        this.menu.addMenuItem(new PopupMenu.PopupBaseMenuItem({ reactive: false }));
        this.menu.addActor(hbox);
        this.updateMonitors();
    }

    _addSwitchWithIcon(hbox, label, icon, toggleCallback, settingsCmd) {
        let switchItem = new PopupMenu.PopupSwitchIconMenuItem(_(label), false, icon, St.IconType.SYMBOLIC);
        switchItem.connect('toggled', toggleCallback.bind(this));
        hbox.add_child(switchItem.actor);

        let gearIcon = new St.Icon({ icon_name: 'applications-system-symbolic', style_class: 'popup-menu-icon' });
        let gearButton = new St.Button({ child: gearIcon, style_class: 'popup-menu-item' });
        gearButton.connect('clicked', () => Util.spawnCommandLine(settingsCmd));
        hbox.add_child(gearButton);

        return switchItem;
    }

    _toggleWifi(switchItem) {
        let command = switchItem.state ? 'nmcli radio wifi on' : 'nmcli radio wifi off';
        GLib.spawn_command_line_sync(command);
    }

    _toggleBluetooth(switchItem) {
        let command = switchItem.state ? 'bluetoothctl power on' : 'bluetoothctl power off';
        GLib.spawn_command_line_sync(command);
    }

    async updateMonitors() {
        this.monitors = (await this._detectDisplays()).map(d => new Monitor(d.index, d.name, d.bus));
        this.monitors.forEach(monitor => monitor.addToMenu(this.menu));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    async _detectDisplays() {
        let output = await new Promise((resolve, reject) => {
            Util.spawnCommandLineAsyncIO("ddcutil detect", (stdout, stderr, exitCode) => {
                exitCode === 0 ? resolve(stdout) : reject(stderr);
            });
        });
        return this._parseDisplays(output);
    }

    _parseDisplays(output) {
        let displays = [];
        let currentDisplay = null;
        output.split("\n").forEach(line => {
            let match = line.match(/^Display (\d+)$/);
            if (match) {
                currentDisplay && displays.push(currentDisplay);
                currentDisplay = { index: parseInt(match[1], 10), name: null, bus: null };
            } else if (currentDisplay) {
                let busMatch = line.match(/^\s+I2C bus:\s+\/dev\/i2c-(\d+)$/);
                let modelMatch = line.match(/^\s+Model:\s+(.+)$/);
                if (busMatch) currentDisplay.bus = parseInt(busMatch[1], 10);
                if (modelMatch) currentDisplay.name = modelMatch[1];
            }
        });
        currentDisplay && displays.push(currentDisplay);
        return displays;
    }

    updateStatus() {
        this._updateWifiSwitchState();
        this._updateBluetoothSwitchState();
        this.monitors.forEach(monitor => monitor.updateBrightness());
    }

    _updateWifiSwitchState() {
        let [result, stdout] = GLib.spawn_command_line_sync("nmcli radio wifi");
        this.wifiSwitch.setToggleState(stdout.toString().trim() === "enabled");
    }

    _updateBluetoothSwitchState() {
        let [result, stdout] = GLib.spawn_command_line_sync("bluetoothctl show");
        this.bluetoothSwitch.setToggleState(stdout.toString().includes("Powered: yes"));
    }

    on_applet_clicked() {
        this.updateStatus();
        this.menu.toggle();
    }
}

/**
 * Monitor class handles brightness and contrast for a connected display.
 */
class Monitor {
    constructor(index, name, bus) {
        this.index = index;
        this.name = name;
        this.brightness = 50;
        this.contrast = 50;
        this.bus = bus;
    }

    addToMenu(menu) {
        menu.addMenuItem(new PopupMenu.PopupMenuItem(this.name));

        // Brightness Label
        let brightnessLabel = new PopupMenu.PopupMenuItem("Brightness", { reactive: false });
        menu.addMenuItem(brightnessLabel);

        // Brightness Slider
        let brightnessSlider = new PopupMenu.PopupSliderMenuItem(this.brightness / 100);
        brightnessSlider.connect("value-changed", (_, value) => this.setBrightness(Math.round(value * 100)));
        menu.addMenuItem(brightnessSlider);

        // Contrast Label
        let contrastLabel = new PopupMenu.PopupMenuItem("Contrast", { reactive: false });
        menu.addMenuItem(contrastLabel);

        // Contrast Slider
        let contrastSlider = new PopupMenu.PopupSliderMenuItem(this.contrast / 100);
        contrastSlider.connect("value-changed", (_, value) => this.setContrast(Math.round(value * 100)));
        menu.addMenuItem(contrastSlider);
    }

    setBrightness(value) {
        this.brightness = value;
        Util.spawnCommandLineAsync(`ddcutil --bus=${this.bus} setvcp 10 ${value}`);
    }

    setContrast(value) {
        this.contrast = value;
        Util.spawnCommandLineAsync(`ddcutil --bus=${this.bus} setvcp 12 ${value}`);
    }

    updateBrightness() {
        Util.spawnCommandLineAsyncIO(`ddcutil --bus=${this.bus} getvcp 10`, (stdout) => {
            let match = stdout.match(/current value =\s*(\d+)/);
            if (match) this.brightness = parseInt(match[1], 10);
        });
    }
}

/**
 * Entry point for the applet.
 */
function main(metadata, orientation, panelHeight, instanceId) {
    return new QuickSettingsApplet(metadata, orientation, panelHeight, instanceId);
}
