import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Registry, ClipboardEntry } from './registry.js';
import { openConfirmDialog } from './confirmDialog.js';
import { PrefsFields } from './constants.js';

const Clipboard = St.Clipboard.get_default();
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

const SETTING_KEY_CLEAR_HISTORY = "clear-history";
const SETTING_KEY_PREV_ENTRY = "prev-entry";
const SETTING_KEY_NEXT_ENTRY = "next-entry";
const SETTING_KEY_TOGGLE_MENU = "toggle-menu";
const INDICATOR_ICON = 'edit-paste-symbolic';

let DELAYED_SELECTION_TIMEOUT = 750;
let MAX_REGISTRY_LENGTH       = 15;
let MAX_ENTRY_LENGTH          = 50;
let CACHE_ONLY_FAVORITE       = false;
let DELETE_ENABLED            = true;
let MOVE_ITEM_FIRST           = false;
let ENABLE_KEYBINDING         = true;
let PRIVATEMODE               = false;
let NOTIFY_ON_COPY            = true;
let CONFIRM_ON_CLEAR          = true;
let MAX_TOPBAR_LENGTH         = 15;
let TOPBAR_DISPLAY_MODE       = 1; //0 - only icon, 1 - only clipboard content, 2 - both
let DISABLE_DOWN_ARROW        = false;
let STRIP_TEXT                = false;

export default class ClipboardIndicatorExtension extends Extension {
    enable () {
        this.clipboardIndicator = new ClipboardIndicator({
            settings: this.getSettings(),
            openSettings: this.openPreferences,
            uuid: this.uuid
        });

        Main.panel.addToStatusArea('clipboardIndicator', this.clipboardIndicator, 1);
    }

    disable () {
        this.clipboardIndicator.destroy();
        this.clipboardIndicator = null;
    }
}

const ClipboardIndicator = GObject.registerClass({
    GTypeName: 'ClipboardIndicator'
}, class ClipboardIndicator extends PanelMenu.Button {
    #refreshInProgress = false;

    constructor (extension) {
        super();
        this.extension = extension;
        this.registry = new Registry(extension);
        this._loadSettings();
        this._buildMenu();
        this._updateTopbarLayout();
        this._setupListener();
    }

    destroy () {
        this._disconnectSettings();
        this._unbindShortcuts();
        this._disconnectSelectionListener();
        this._clearLabelTimeout();
        this._clearDelayedSelectionTimeout();

        super.destroy();
    }

    _init () {
        super._init(0.0, "ClipboardIndicator");
        this._settingsChangedId = null;
        this._selectionOwnerChangedId = null;
        this._historyLabelTimeoutId = null;
        this._historyLabel = null;
        this._buttonText = null;
        this._disableDownArrow = null;

        this._shortcutsBindingIds = [];
        this.clipItemsRadioGroup = [];

        let hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box clipboard-indicator-hbox'
        });
        this.icon = new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon'
        });

        this._buttonText = new St.Label({
            text: _('Text will be here'),
            y_align: Clutter.ActorAlign.CENTER
        });

        this._buttonImgPreview = new St.Bin({
            style_class: 'clipboard-indicator-topbar-preview'
        });

        hbox.add_child(this.icon);
        hbox.add_child(this._buttonText);
        hbox.add_child(this._buttonImgPreview);
        this._downArrow = PopupMenu.arrowIcon(St.Side.BOTTOM);
        hbox.add(this._downArrow);
        this.add_child(hbox);
        this._createHistoryLabel();
    }

    #updateIndicatorContent(entry) {
        if (TOPBAR_DISPLAY_MODE !== 1 && TOPBAR_DISPLAY_MODE !== 2) {
            return;
        }

        if (!entry || PRIVATEMODE) {
            this._buttonImgPreview.destroy_all_children();
            this._buttonText.set_text("...")
        } else {
            if (entry.isText()) {
                this._buttonText.set_text(this._truncate(entry.getStringValue(), MAX_TOPBAR_LENGTH));
                this._buttonImgPreview.destroy_all_children();
            }
            else if (entry.isImage()) {
                this._buttonText.set_text('');
                this._buttonImgPreview.destroy_all_children();
                this.registry.getEntryAsImage(entry).then(img => {
                    img.add_style_class_name('clipboard-indicator-img-preview');
                    img.y_align = Clutter.ActorAlign.CENTER;

                    // icon only renders properly in setTimeout for some arcane reason
                    setTimeout(() => {
                        this._buttonImgPreview.set_child(img);
                    }, 0);
                });
            }
        }
    }

    _buildMenu () {
        let that = this;
        this._getCache(clipHistory => {
            let lastIdx = clipHistory.length - 1;
            let clipItemsArr = that.clipItemsRadioGroup;

            /* This create the search entry, which is add to a menuItem.
            The searchEntry is connected to the function for research.
            The menu itself is connected to some shitty hack in order to
            grab the focus of the keyboard. */
            that._entryItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });
            that.searchEntry = new St.Entry({
                name: 'searchEntry',
                style_class: 'search-entry',
                can_focus: true,
                hint_text: _('Type here to search...'),
                track_hover: true,
                x_expand: true,
                y_expand: true,
                primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic' })
            });

            that.searchEntry.get_clutter_text().connect(
                'text-changed',
                that._onSearchTextChanged.bind(that)
            );

            that._entryItem.add(that.searchEntry);

            that.menu.connect('open-state-changed', (self, open) => {
                let a = setInterval(() => {
                    if (open) {
                        if (this.clipItemsRadioGroup.length > 0) {
                            that.searchEntry.set_text('');
                            global.stage.set_key_focus(that.searchEntry);
                        }
                        else {
                            global.stage.set_key_focus(this._onPrivateModeSwitch);
                        }
                    }
                    clearInterval(a);
                }, 50);
            });

            // Create menu sections for items
            // Favorites
            that.favoritesSection = new PopupMenu.PopupMenuSection();

            that.scrollViewFavoritesMenuSection = new PopupMenu.PopupMenuSection();
            let favoritesScrollView = new St.ScrollView({
                style_class: 'ci-history-menu-section',
                overlay_scrollbars: true
            });
            favoritesScrollView.add_actor(that.favoritesSection.actor);

            that.scrollViewFavoritesMenuSection.actor.add_actor(favoritesScrollView);
            that.menu.addMenuItem(that.scrollViewFavoritesMenuSection);
            this.favoritesSeparator = new PopupMenu.PopupSeparatorMenuItem();

            // History
            that.historySection = new PopupMenu.PopupMenuSection();

            that.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
            let historyScrollView = new St.ScrollView({
                style_class: 'ci-history-menu-section',
                overlay_scrollbars: true
            });
            historyScrollView.add_actor(that.historySection.actor);

            that.scrollViewMenuSection.actor.add_actor(historyScrollView);

            that.menu.addMenuItem(that.scrollViewMenuSection);

            // Add separator
            this.historySeparator = new PopupMenu.PopupSeparatorMenuItem();

            // Private mode switch
            that.privateModeMenuItem = new PopupMenu.PopupSwitchMenuItem(
                _("Private mode"), PRIVATEMODE, { reactive: true });
            that.privateModeMenuItem.connect('toggled',
                that._onPrivateModeSwitch.bind(that));
            that.privateModeMenuItem.insert_child_at_index(
                new St.Icon({
                    icon_name: 'security-medium-symbolic',
                    style_class: 'clipboard-menu-icon',
                    y_align: Clutter.ActorAlign.CENTER
                }),
                0
            );
            that.menu.addMenuItem(that.privateModeMenuItem);

            // Add 'Clear' button which removes all items from cache
            this.clearMenuItem = new PopupMenu.PopupMenuItem(_('Clear history'));
            this.clearMenuItem.insert_child_at_index(
                new St.Icon({
                    icon_name: 'user-trash-symbolic',
                    style_class: 'clipboard-menu-icon',
                    y_align: Clutter.ActorAlign.CENTER
                }),
                0
            );
            this.clearMenuItem.connect('activate', that._removeAll.bind(that));

            // Add 'Settings' menu item to open settings
            this.settingsMenuItem = new PopupMenu.PopupMenuItem(_('Settings'));
            this.settingsMenuItem.insert_child_at_index(
                new St.Icon({
                    icon_name: 'preferences-system-symbolic',
                    style_class: 'clipboard-menu-icon',
                    y_align: Clutter.ActorAlign.CENTER
                }),
                0
            );
            that.menu.addMenuItem(this.settingsMenuItem);
            this.settingsMenuItem.connect('activate', that._openSettings.bind(that));

            // Empty state section
            this.emptyStateSection = new St.BoxLayout({
                style_class: 'clipboard-indicator-empty-state',
                vertical: true
            });
            this.emptyStateSection.add_child(new St.Icon({
                icon_name: INDICATOR_ICON,
                style_class: 'system-status-icon clipboard-indicator-icon',
                x_align: Clutter.ActorAlign.CENTER
            }));
            this.emptyStateSection.add_child(new St.Label({
                text: _('Clipboard is empty'),
                x_align: Clutter.ActorAlign.CENTER
            }));

            // Add cached items
            clipHistory.forEach(entry => this._addEntry(entry));

            if (lastIdx >= 0) {
                that._selectMenuItem(clipItemsArr[lastIdx]);
            }

            if (clipHistory.length === 0) {
                this.#renderEmptyState();
            }

            this.#showElements();
        });
    }

    #hideElements() {
        this.menu.box.remove_child(this._entryItem);
        this.menu.box.remove_child(this.favoritesSeparator);
        this.menu.box.remove_child(this.historySeparator);
        this.menu.box.remove_child(this.clearMenuItem);
    }

    #showElements() {
        if (this.clipItemsRadioGroup.length > 0) {
            this.menu.box.insert_child_at_index(this._entryItem, 0);
            this.menu.box.insert_child_below(this.clearMenuItem, this.settingsMenuItem);
            this.menu.box.remove_child(this.emptyStateSection);
        }
        else {
            this.menu.box.insert_child_at_index(this.emptyStateSection, 0);
        }

        if (this.favoritesSection._getMenuItems().length > 0) {
            this.menu.box.insert_child_above(this.favoritesSeparator, this.scrollViewFavoritesMenuSection.actor);
        }

        if (this.historySection._getMenuItems().length > 0) {
            this.menu.box.insert_child_above(this.historySeparator, this.scrollViewMenuSection.actor);
        }
    }

    #renderEmptyState () {
        this.#hideElements();
        this.menu.box.insert_child_at_index(this.emptyStateSection, 0);
    }

    /* When text change, this function will check, for each item of the
    historySection and favoritesSestion, if it should be visible or not (based on words contained
    in the clipContents attribute of the item). It doesn't destroy or create
    items. It the entry is empty, the section is restored with all items
    set as visible. */
    _onSearchTextChanged () {
        let searchedText = this.searchEntry.get_text().toLowerCase();

        if(searchedText === '') {
            this._getAllIMenuItems().forEach(function(mItem){
                mItem.actor.visible = true;
            });
        }
        else {
            this._getAllIMenuItems().forEach(function(mItem){
                let text = mItem.clipContents.toLowerCase();
                let isMatching = text.indexOf(searchedText) >= 0;
                mItem.actor.visible = isMatching
            });
        }
    }

    _truncate (string, length) {
        let shortened = string.replace(/\s+/g, ' ');

        if (shortened.length > length)
            shortened = shortened.substring(0,length-1) + '...';

        return shortened;
    }

    _setEntryLabel (menuItem) {
        const { entry } = menuItem;
        if (entry.isText()) {
            menuItem.label.set_text(this._truncate(entry.getStringValue(), MAX_ENTRY_LENGTH));
        }
        else if (entry.isImage()) {
            this.registry.getEntryAsImage(entry).then(img => {
                img.add_style_class_name('clipboard-menu-img-preview');
                if (menuItem.previewImage) {
                    menuItem.remove_child(menuItem.previewImage);
                }
                menuItem.previewImage = img;
                menuItem.insert_child_below(img, menuItem.label);
            });
        }
    }

    _addEntry (entry, autoSelect, autoSetClip) {
        let menuItem = new PopupMenu.PopupMenuItem('');

        menuItem.menu = this.menu;
        menuItem.entry = entry;
        menuItem.clipContents = entry.getStringValue();
        menuItem.radioGroup = this.clipItemsRadioGroup;
        menuItem.buttonPressId = menuItem.connect('activate',
            autoSet => this._onMenuItemSelectedAndMenuClose(menuItem, autoSet));

        this._setEntryLabel(menuItem);
        this.clipItemsRadioGroup.push(menuItem);

        // Favorite button
        let icon_name = entry.isFavorite() ? 'starred-symbolic' : 'non-starred-symbolic';
        let iconfav = new St.Icon({
            icon_name: icon_name,
            style_class: 'system-status-icon'
        });

        let icofavBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            child: iconfav,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true
        });

        menuItem.actor.add_child(icofavBtn);
        menuItem.icofavBtn = icofavBtn;
        menuItem.favoritePressId = icofavBtn.connect('clicked',
            () => this._favoriteToggle(menuItem)
        );

        // Delete button
        let icon = new St.Icon({
            icon_name: 'edit-delete-symbolic', //'mail-attachment-symbolic',
            style_class: 'system-status-icon'
        });

        let icoBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            child: icon,
            x_align: Clutter.ActorAlign.END,
            x_expand: false,
            y_expand: true
        });

        menuItem.actor.add_child(icoBtn);
        menuItem.icoBtn = icoBtn;
        menuItem.deletePressId = icoBtn.connect('clicked',
            () => this._removeEntry(menuItem, 'delete')
        );

        if (entry.isFavorite()) {
            this.favoritesSection.addMenuItem(menuItem, 0);
        } else {
            this.historySection.addMenuItem(menuItem, 0);
        }

        if (autoSelect === true) {
            this._selectMenuItem(menuItem, autoSetClip);
        }
        else {
            menuItem.setOrnament(PopupMenu.Ornament.NONE);
        }

        if (this.clipItemsRadioGroup.length === 1) {
            this.#showElements();
        }
    }

    _favoriteToggle (menuItem) {
        menuItem.entry.favorite = menuItem.entry.isFavorite() ? false : true;
        this._moveItemFirst(menuItem);
        this._updateCache();
        this.#showElements();
    }

    _confirmRemoveAll () {
        const title = _("Clear all?");
        const message = _("Are you sure you want to delete all clipboard items?");
        const sub_message = _("This operation cannot be undone.");

        openConfirmDialog(title, message, sub_message, _("Clear"), _("Cancel"), () => {
            let that = this;
            that._clearHistory();
        }
      );
    }

    _clearHistory () {
        let that = this;
        // We can't actually remove all items, because the clipboard still
        // has data that will be re-captured on next refresh, so we remove
        // all except the currently selected item
        // Don't remove favorites here
        that.historySection._getMenuItems().forEach(function (mItem) {
            if (!mItem.currentlySelected) {
                let idx = that.clipItemsRadioGroup.indexOf(mItem);
                mItem.destroy();
                that.clipItemsRadioGroup.splice(idx, 1);
            }
        });
        that._updateCache();
        that._showNotification(_("Clipboard history cleared"));
    }

    _removeAll () {
        var that = this;

        if (CONFIRM_ON_CLEAR) {
            that._confirmRemoveAll();
        } else {
            that._clearHistory();
        }
    }

    _removeEntry (menuItem, event) {
        let itemIdx = this.clipItemsRadioGroup.indexOf(menuItem);

        if(event === 'delete' && menuItem.currentlySelected) {
            this.#clearClipboard();
        }

        menuItem.destroy();
        this.clipItemsRadioGroup.splice(itemIdx,1);

        if (menuItem.entry.isImage()) {
            this.registry.deleteEntryFile(menuItem.entry);
        }
        this._updateCache();

        if (this.clipItemsRadioGroup.length === 0) {
            this.#renderEmptyState();
        }
    }

    _removeOldestEntries () {
        let that = this;

        let clipItemsRadioGroupNoFavorite = that.clipItemsRadioGroup.filter(
            item => item.entry.isFavorite() === false);

        const origSize = clipItemsRadioGroupNoFavorite.length;

        while (clipItemsRadioGroupNoFavorite.length > MAX_REGISTRY_LENGTH) {
            let oldestNoFavorite = clipItemsRadioGroupNoFavorite.shift();
            that._removeEntry(oldestNoFavorite);

            clipItemsRadioGroupNoFavorite = that.clipItemsRadioGroup.filter(
                item => item.entry.isFavorite() === false);
        }

        if (clipItemsRadioGroupNoFavorite.length < origSize) {
            that._updateCache();
        }
    }

    _onMenuItemSelected (menuItem, autoSet) {
        for (let otherMenuItem of menuItem.radioGroup) {
            let clipContents = menuItem.clipContents;

            if (otherMenuItem === menuItem && clipContents) {
                menuItem.setOrnament(PopupMenu.Ornament.DOT);
                menuItem.currentlySelected = true;
                if (autoSet !== false)
                    this.#updateClipboard(menuItem.entry);
            }
            else {
                otherMenuItem.setOrnament(PopupMenu.Ornament.NONE);
                otherMenuItem.currentlySelected = false;
            }
        }
    }

    _selectMenuItem (menuItem, autoSet) {
        this._onMenuItemSelected(menuItem, autoSet);
        this.#updateIndicatorContent(menuItem.entry);
    }

    _onMenuItemSelectedAndMenuClose (menuItem, autoSet) {
        for (let otherMenuItem of menuItem.radioGroup) {
            let clipContents = menuItem.clipContents;

            if (menuItem === otherMenuItem && clipContents) {
                menuItem.setOrnament(PopupMenu.Ornament.DOT);
                menuItem.currentlySelected = true;
                if (autoSet !== false)
                    this.#updateClipboard(menuItem.entry);
            }
            else {
                otherMenuItem.setOrnament(PopupMenu.Ornament.NONE);
                otherMenuItem.currentlySelected = false;
            }
        }

        menuItem.menu.close();
    }

    _getCache (cb) {
        return this.registry.read(cb);
    }

    #addToCache (entry) {
        const entries = this.clipItemsRadioGroup
            .map(menuItem => menuItem.entry)
            .filter(entry => CACHE_ONLY_FAVORITE == false || entry.isFavorite())
            .concat([entry]);
        this.registry.write(entries);
    }

    _updateCache () {
        const entries = this.clipItemsRadioGroup
            .map(menuItem => menuItem.entry)
            .filter(entry => CACHE_ONLY_FAVORITE == false || entry.isFavorite());

        this.registry.write(entries);
    }

    async _onSelectionChange (selection, selectionType, selectionSource) {
        if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
            this._refreshIndicator();
        }
    }

    async _refreshIndicator () {
        if (this.#refreshInProgress) return;
        this.#refreshInProgress = true;
        if (PRIVATEMODE) return; // Private mode, do not.

        try {
            const result = await this.#getClipboardContent();

            if (result) {
                for (let menuItem of this.clipItemsRadioGroup) {
                    if (menuItem.entry.equals(result)) {
                        this._selectMenuItem(menuItem, false);

                        if (!menuItem.entry.isFavorite() && MOVE_ITEM_FIRST) {
                            this._moveItemFirst(menuItem);
                        }

                        return;
                    }
                }

                this.#addToCache(result);
                this._addEntry(result, true);
                this._removeOldestEntries();
                if (NOTIFY_ON_COPY) {
                    this._showNotification(_("Copied to clipboard"), notif => {
                        notif.addAction(_('Cancel'), this._cancelNotification);
                    });
                }
            }
        }
        catch (e) {
            console.error('Clipboard Indicator: Failed to refresh indicator');
            console.error(e);
        }
        finally {
            this.#refreshInProgress = false;
        }
    }

    _processClipboardContent (text) {
        const that = this;

        if (STRIP_TEXT) {
            text = text.trim();
        }

        if (text !== "" && text) {
            let registry = that.clipItemsRadioGroup.map(function (menuItem) {
                return menuItem.clipContents;
            });

            const itemIndex = registry.indexOf(text);

            if (itemIndex < 0) {
                const entry = new ClipboardEntry(
                    'text/plain', new TextEncoder().encode(text), false
                );
                this.#addToCache(entry);
                that._addEntry(entry, true, false);
                that._removeOldestEntries();
                if (NOTIFY_ON_COPY) {
                    that._showNotification(_("Copied to clipboard"), notif => {
                        notif.addAction(_('Cancel'), that._cancelNotification.bind(that));
                    });
                }
            }
            else if (itemIndex >= 0 && itemIndex < registry.length) {
                const item = that._findItem(text);
                that._selectMenuItem(item, false);

                if (!item.entry.isFavorite() && MOVE_ITEM_FIRST) {
                    that._moveItemFirst(item);
                }
            }
            }
    }

    _moveItemFirst (item) {
        this._removeEntry(item);
        this._addEntry(item.entry, item.currentlySelected, false);
        this._updateCache();
    }

    _findItem (text) {
        return this.clipItemsRadioGroup.filter(
            item => item.clipContents === text)[0];
    }

    _getCurrentlySelectedItem () {
        return this.clipItemsRadioGroup.find(item => item.currentlySelected);
    }

    _getAllIMenuItems () {
        return this.historySection._getMenuItems().concat(this.favoritesSection._getMenuItems());
    }

    _setupListener () {
        const metaDisplay = Shell.Global.get().get_display();
        const selection = metaDisplay.get_selection();
        this._setupSelectionTracking(selection);
    }

    _setupSelectionTracking (selection) {
        this.selection = selection;
        this._selectionOwnerChangedId = selection.connect('owner-changed', (selection, selectionType, selectionSource) => {
            this._onSelectionChange(selection, selectionType, selectionSource);
        });
    }

    _openSettings () {
        this.extension.openSettings();
    }

    _initNotifSource () {
        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source('ClipboardIndicator',
                                    INDICATOR_ICON);
            this._notifSource.connect('destroy', () => {
                this._notifSource = null;
            });
            Main.messageTray.add(this._notifSource);
        }
    }

    _cancelNotification () {
        if (this.clipItemsRadioGroup.length >= 2) {
            let clipSecond = this.clipItemsRadioGroup.length - 2;
            let previousClip = this.clipItemsRadioGroup[clipSecond];
            this.#updateClipboard(previousClip.entry);
            previousClip.setOrnament(PopupMenu.Ornament.DOT);
            previousClip.icoBtn.visible = false;
            previousClip.currentlySelected = true;
        } else {
            this.#clearClipboard();
        }
        let clipFirst = this.clipItemsRadioGroup.length - 1;
        this._removeEntry(this.clipItemsRadioGroup[clipFirst]);
    }

    _showNotification (message, transformFn) {
        let notification = null;

        this._initNotifSource();

        if (this._notifSource.count === 0) {
            notification = new MessageTray.Notification(this._notifSource, message);
        }
        else {
            notification = this._notifSource.notifications[0];
            notification.update(message, '', { clear: true });
        }

        if (typeof transformFn === 'function') {
            transformFn(notification);
        }

        notification.setTransient(true);
        this._notifSource.showNotification(notification);
    }

    _createHistoryLabel () {
        this._historyLabel = new St.Label({
            style_class: 'ci-notification-label',
            text: ''
        });

        global.stage.add_actor(this._historyLabel);

        this._historyLabel.hide();
    }

    _onPrivateModeSwitch () {
        let that = this;
        PRIVATEMODE = this.privateModeMenuItem.state;
        // We hide the history in private ModeTypee because it will be out of sync (selected item will not reflect clipboard)
        this.scrollViewMenuSection.actor.visible = !PRIVATEMODE;
        this.scrollViewFavoritesMenuSection.actor.visible = !PRIVATEMODE;
        // If we get out of private mode then we restore the clipboard to old state
        if (!PRIVATEMODE) {
            let selectList = this.clipItemsRadioGroup.filter((item) => !!item.currentlySelected);

            if (selectList.length) {
                this._selectMenuItem(selectList[0]);
            } else {
                // Nothing to return to, let's empty it instead
                this.#clearClipboard();
            }

            this.#getClipboardContent().then(entry => {
                if (!entry) return;
                this.#updateIndicatorContent(entry);
            }).catch(e => console.error(e));

            this.icon.remove_style_class_name('private-mode');
            if (this.clipItemsRadioGroup.length > 0) {
                this.#showElements();
            }
        } else {
            this.#updateIndicatorContent(null);
            this.#hideElements();
        }
    }

    _loadSettings () {
        this._settingsChangedId = this.extension.settings.connect('changed',
            this._onSettingsChange.bind(this));

        this._fetchSettings();

        if (ENABLE_KEYBINDING)
            this._bindShortcuts();
    }

    _fetchSettings () {
        const { settings } = this.extension;
        MAX_REGISTRY_LENGTH  = settings.get_int(PrefsFields.HISTORY_SIZE);
        MAX_ENTRY_LENGTH     = settings.get_int(PrefsFields.PREVIEW_SIZE);
        CACHE_ONLY_FAVORITE  = settings.get_boolean(PrefsFields.CACHE_ONLY_FAVORITE);
        DELETE_ENABLED       = settings.get_boolean(PrefsFields.DELETE);
        MOVE_ITEM_FIRST      = settings.get_boolean(PrefsFields.MOVE_ITEM_FIRST);
        NOTIFY_ON_COPY       = settings.get_boolean(PrefsFields.NOTIFY_ON_COPY);
        CONFIRM_ON_CLEAR     = settings.get_boolean(PrefsFields.CONFIRM_ON_CLEAR);
        ENABLE_KEYBINDING    = settings.get_boolean(PrefsFields.ENABLE_KEYBINDING);
        MAX_TOPBAR_LENGTH    = settings.get_int(PrefsFields.TOPBAR_PREVIEW_SIZE);
        TOPBAR_DISPLAY_MODE  = settings.get_int(PrefsFields.TOPBAR_DISPLAY_MODE_ID);
        DISABLE_DOWN_ARROW   = settings.get_boolean(PrefsFields.DISABLE_DOWN_ARROW);
        STRIP_TEXT           = settings.get_boolean(PrefsFields.STRIP_TEXT);
    }

    async _onSettingsChange () {
        var that = this;

        // Load the settings into variables
        that._fetchSettings();

        // Remove old entries in case the registry size changed
        that._removeOldestEntries();

        // Re-set menu-items lables in case preview size changed
        this._getAllIMenuItems().forEach(function (mItem) {
            that._setEntryLabel(mItem);
        });

        //update topbar
        this._updateTopbarLayout();
        that.#updateIndicatorContent(await this.#getClipboardContent());

        // Bind or unbind shortcuts
        if (ENABLE_KEYBINDING)
            that._bindShortcuts();
        else
            that._unbindShortcuts();
    }

    _bindShortcuts () {
        this._unbindShortcuts();
        this._bindShortcut(SETTING_KEY_CLEAR_HISTORY, this._removeAll);
        this._bindShortcut(SETTING_KEY_PREV_ENTRY, this._previousEntry);
        this._bindShortcut(SETTING_KEY_NEXT_ENTRY, this._nextEntry);
        this._bindShortcut(SETTING_KEY_TOGGLE_MENU, this._toggleMenu);
    }

    _unbindShortcuts () {
        this._shortcutsBindingIds.forEach(
            (id) => Main.wm.removeKeybinding(id)
        );

        this._shortcutsBindingIds = [];
    }

    _bindShortcut (name, cb) {
        var ModeType = Shell.hasOwnProperty('ActionMode') ?
            Shell.ActionMode : Shell.KeyBindingMode;

        Main.wm.addKeybinding(
            name,
            this.extension.settings,
            Meta.KeyBindingFlags.NONE,
            ModeType.ALL,
            cb.bind(this)
        );

        this._shortcutsBindingIds.push(name);
    }

    _updateTopbarLayout () {
        if(TOPBAR_DISPLAY_MODE === 0){
            this.icon.visible = true;
            this._buttonText.visible = false;
        }
        if(TOPBAR_DISPLAY_MODE === 1){
            this.icon.visible = false;
            this._buttonText.visible = true;
        }
        if(TOPBAR_DISPLAY_MODE === 2){
            this.icon.visible = true;
            this._buttonText.visible = true;
        }
        if(!DISABLE_DOWN_ARROW) {
            this._downArrow.visible = true;
        } else {
            this._downArrow.visible = false;
        }
    }

    _disconnectSettings () {
        if (!this._settingsChangedId)
            return;

        this.extension.settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;
    }

    _disconnectSelectionListener () {
        if (!this._selectionOwnerChangedId)
            return;

        this.selection.disconnect(this._selectionOwnerChangedId);
    }

    _clearLabelTimeout () {
        if (!this._historyLabelTimeoutId)
            return;

        clearInterval(this._historyLabelTimeoutId);
        this._historyLabelTimeoutId = null;
    }

    _clearDelayedSelectionTimeout () {
        if (this._delayedSelectionTimeoutId) {
            clearInterval(this._delayedSelectionTimeoutId);
        }
    }

    _selectEntryWithDelay (entry) {
        let that = this;
        that._selectMenuItem(entry, false);

        that._delayedSelectionTimeoutId = setTimeout(function () {
            that._selectMenuItem(entry);  //select the item
            that._delayedSelectionTimeoutId = null;
        }, DELAYED_SELECTION_TIMEOUT);
    }

    _previousEntry () {
        let that = this;

        that._clearDelayedSelectionTimeout();

        this._getAllIMenuItems().some(function (mItem, i, menuItems){
            if (mItem.currentlySelected) {
                i--;                                 //get the previous index
                if (i < 0) i = menuItems.length - 1; //cycle if out of bound
                let index = i + 1;                   //index to be displayed
                that._showNotification(index + ' / ' + menuItems.length + ': ' + menuItems[i].entry.getStringValue());
                if (MOVE_ITEM_FIRST) {
                    that._selectEntryWithDelay(menuItems[i]);
                }
                else {
                    that._selectMenuItem(menuItems[i]);
                }
                return true;
            }
            return false;
        });
    }

    _nextEntry () {
        let that = this;

        that._clearDelayedSelectionTimeout();

        this._getAllIMenuItems().some(function (mItem, i, menuItems){
            if (mItem.currentlySelected) {
                i++;                                 //get the next index
                if (i === menuItems.length) i = 0;   //cycle if out of bound
                let index = i + 1;                     //index to be displayed
                that._showNotification(index + ' / ' + menuItems.length + ': ' + menuItems[i].entry.getStringValue());
                if (MOVE_ITEM_FIRST) {
                    that._selectEntryWithDelay(menuItems[i]);
                }
                else {
                    that._selectMenuItem(menuItems[i]);
                }
                return true;
            }
            return false;
        });
    }

    _toggleMenu () {
        this.menu.toggle();
    }

    #clearClipboard () {
        Clipboard.set_text(CLIPBOARD_TYPE, "");
        this.#updateIndicatorContent(null);
    }

    #updateClipboard (entry) {
        Clipboard.set_content(CLIPBOARD_TYPE, entry.mimetype(), entry.asBytes());
    }

    async #getClipboardContent () {
        const mimetypes = [
            'text/plain',
            'image/gif',
            'image/png',
            'image/jpg',
            'image/jpeg',
            'image/webp',
            'image/svg+xml',
            'text/html',
        ];

        for (let type of mimetypes) {
            let result = await new Promise(resolve => Clipboard.get_content(CLIPBOARD_TYPE, type, (clipBoard, bytes) => {
                if (bytes === null || bytes.get_size() === 0) {
                    resolve(null);
                    return;
                }

                const entry = new ClipboardEntry(type, bytes.get_data(), false);
                this.registry.writeEntryFile(entry);
                resolve(entry);
            }));

            if (result) return result;
        }

        return null;
    }
});
