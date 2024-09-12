"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Player = void 0;
const Constants_1 = require("./Constants");
const BandCampSearch_1 = require("./CustomSearches/BandCampSearch");
const Filters_1 = require("./Filters");
const Queue_1 = require("./Queue");
const Utils_1 = require("./Utils");
class Player {
    /** Filter Manager per player */
    filterManager;
    /** circular reference to the lavalink Manager from the Player for easier use */
    LavalinkManager;
    /** Player options currently used, mutation doesn't affect player's state */
    options;
    /** The lavalink node assigned the the player, don't change it manually */
    node;
    /** The queue from the player */
    queue;
    /** The Guild Id of the Player */
    guildId;
    /** The Voice Channel Id of the Player */
    voiceChannelId = null;
    /** The Text Channel Id of the Player */
    textChannelId = null;
    /** States if the Bot is supposed to be outputting audio */
    playing = false;
    /** States if the Bot is paused or not */
    paused = false;
    /** Repeat Mode of the Player */
    repeatMode = "off";
    /** Player's ping */
    ping = {
        /* Response time for rest actions with Lavalink Server */
        lavalink: 0,
        /* Latency of the Discord's Websocket Voice Server */
        ws: 0
    };
    /** The Display Volume */
    volume = 100;
    /** The Volume Lavalink actually is outputting */
    lavalinkVolume = 100;
    /** The current Positin of the player (Calculated) */
    get position() {
        return this.lastPosition + (this.lastPositionChange ? Date.now() - this.lastPositionChange : 0);
    }
    /** The timestamp when the last position change update happened */
    lastPositionChange = null;
    /** The current Positin of the player (from Lavalink) */
    lastPosition = 0;
    lastSavedPosition = 0;
    /** When the player was created [Timestamp in Ms] (from lavalink) */
    createdTimeStamp;
    /** The Player Connection's State (from Lavalink) */
    connected = false;
    /** Voice Server Data (from Lavalink) */
    voice = {
        endpoint: null,
        sessionId: null,
        token: null
    };
    /** Custom data for the player */
    data = {};
    /**
     * Create a new Player
     * @param options
     * @param LavalinkManager
     */
    constructor(options, LavalinkManager) {
        this.options = options;
        this.filterManager = new Filters_1.FilterManager(this);
        this.LavalinkManager = LavalinkManager;
        this.guildId = this.options.guildId;
        this.voiceChannelId = this.options.voiceChannelId;
        this.textChannelId = this.options.textChannelId || null;
        this.node = typeof this.options.node === "string"
            ? this.LavalinkManager.nodeManager.nodes.get(this.options.node)
            : this.options.node;
        if (!this.node || typeof this.node.request !== "function") {
            if (typeof this.options.node === "string" && this.LavalinkManager.options?.advancedOptions?.enableDebugEvents) {
                this.LavalinkManager.emit("debug", Constants_1.DebugEvents.PlayerCreateNodeNotFound, {
                    state: "warn",
                    message: `Player was created with provided node Id: ${this.options.node}, but no node with that Id was found.`,
                    functionLayer: "Player > constructor()",
                });
            }
            const least = this.LavalinkManager.nodeManager.leastUsedNodes();
            this.node = least.filter(v => options.vcRegion ? v.options?.regions?.includes(options.vcRegion) : true)[0] || least[0] || null;
        }
        if (!this.node)
            throw new Error("No available Node was found, please add a LavalinkNode to the Manager via Manager.NodeManager#createNode");
        if (typeof options.volume === "number" && !isNaN(options.volume))
            this.volume = Number(options.volume);
        this.volume = Math.round(Math.max(Math.min(this.volume, 1000), 0));
        this.lavalinkVolume = Math.round(Math.max(Math.min(Math.round(this.LavalinkManager.options.playerOptions.volumeDecrementer
            ? this.volume * this.LavalinkManager.options.playerOptions.volumeDecrementer
            : this.volume), 1000), 0));
        this.LavalinkManager.emit("playerCreate", this);
        this.queue = new Queue_1.Queue(this.guildId, {}, new Queue_1.QueueSaver(this.LavalinkManager.options.queueOptions), this.LavalinkManager.options.queueOptions);
    }
    /**
     * Set custom data.
     * @param key
     * @param value
     */
    set(key, value) {
        this.data[key] = value;
        return this;
    }
    /**
     * Get custom data.
     * @param key
     */
    get(key) {
        return this.data[key];
    }
    /**
     * CLears all the custom data.
     */
    clearData() {
        const toKeep = Object.keys(this.data).filter(v => v.startsWith("internal_"));
        for (const key in this.data) {
            if (toKeep.includes(key))
                continue;
            delete this.data[key];
        }
        return this;
    }
    /**
     * Get all custom Data
     */
    getAllData() {
        return Object.fromEntries(Object.entries(this.data).filter(v => !v[0].startsWith("internal_")));
    }
    /**
     * Play the next track from the queue / a specific track, with playoptions for Lavalink
     * @param options
     */
    async play(options = {}) {
        if (this.get("internal_queueempty")) {
            if (typeof this.options.node === "string" && this.LavalinkManager.options?.advancedOptions?.enableDebugEvents) {
                this.LavalinkManager.emit("debug", Constants_1.DebugEvents.PlayerPlayQueueEmptyTimeoutClear, {
                    state: "log",
                    message: `Player was called to play something, while there was a queueEmpty Timeout set, clearing the timeout.`,
                    functionLayer: "Player > play()",
                });
            }
            clearTimeout(this.get("internal_queueempty"));
            this.set("internal_queueempty", undefined);
        }
        // if clientTrack provided, override options.track object
        if (options?.clientTrack && (this.LavalinkManager.utils.isTrack(options?.clientTrack) || this.LavalinkManager.utils.isUnresolvedTrack(options.clientTrack))) {
            if (this.LavalinkManager.utils.isUnresolvedTrack(options.clientTrack))
                await options.clientTrack.resolve(this);
            if ((typeof options.track?.userData === "object" || typeof options.clientTrack?.userData === "object") && options.clientTrack)
                options.clientTrack.userData = { ...(options?.clientTrack.userData || {}), ...(options.track?.userData || {}) };
            options.track = {
                encoded: options.clientTrack?.encoded,
                requester: options.clientTrack?.requester,
                userData: options.clientTrack?.userData,
            };
        }
        // if either encoded or identifier is provided generate the data to play them
        if (options?.track?.encoded || options?.track?.identifier) {
            this.queue.current = options.clientTrack || null;
            this.queue.utils.save();
            if (typeof options?.volume === "number" && !isNaN(options?.volume)) {
                this.volume = Math.max(Math.min(options?.volume, 500), 0);
                let vol = Number(this.volume);
                if (this.LavalinkManager.options.playerOptions.volumeDecrementer)
                    vol *= this.LavalinkManager.options.playerOptions.volumeDecrementer;
                this.lavalinkVolume = Math.round(vol);
                options.volume = this.lavalinkVolume;
            }
            const track = Object.fromEntries(Object.entries({
                encoded: options.track.encoded,
                identifier: options.track.identifier,
            }).filter(v => typeof v[1] !== "undefined"));
            if (typeof options.track.userData === "object")
                track.userData = {
                    ...(options.track.userData || {})
                };
            if (typeof options?.track?.requester === "object")
                track.userData = {
                    ...(track.userData || {}),
                    requester: this.LavalinkManager.utils.getTransformedRequester(options?.track?.requester || {})
                };
            if (typeof this.options.node === "string" && this.LavalinkManager.options?.advancedOptions?.enableDebugEvents) {
                this.LavalinkManager.emit("debug", Constants_1.DebugEvents.PlayerPlayWithTrackReplace, {
                    state: "log",
                    message: `Player was called to play something, with a specific track provided. Replacing the current Track and resolving the track on trackStart Event.`,
                    functionLayer: "Player > play()",
                });
            }
            return this.node.updatePlayer({
                guildId: this.guildId,
                noReplace: false,
                playerOptions: Object.fromEntries(Object.entries({
                    track,
                    position: options.position ?? undefined,
                    paused: options.paused ?? undefined,
                    endTime: options?.endTime ?? undefined,
                    filters: options?.filters ?? undefined,
                    volume: options.volume ?? this.lavalinkVolume ?? undefined,
                    voice: options.voice ?? undefined,
                }).filter(v => typeof v[1] !== "undefined")),
            });
        }
        if (!this.queue.current && this.queue.tracks.length)
            await (0, Utils_1.queueTrackEnd)(this);
        if (this.queue.current && this.LavalinkManager.utils.isUnresolvedTrack(this.queue.current)) {
            if (typeof this.options.node === "string" && this.LavalinkManager.options?.advancedOptions?.enableDebugEvents) {
                this.LavalinkManager.emit("debug", Constants_1.DebugEvents.PlayerPlayUnresolvedTrack, {
                    state: "log",
                    message: `Player Play was called, current Queue Song is unresolved, resolving the track.`,
                    functionLayer: "Player > play()",
                });
            }
            try {
                // resolve the unresolved track
                await this.queue.current.resolve(this);
                if (typeof options.track?.userData === "object" && this.queue.current)
                    this.queue.current.userData = { ...(this.queue.current?.userData || {}), ...(options.track?.userData || {}) };
            }
            catch (error) {
                if (typeof this.options.node === "string" && this.LavalinkManager.options?.advancedOptions?.enableDebugEvents) {
                    this.LavalinkManager.emit("debug", Constants_1.DebugEvents.PlayerPlayUnresolvedTrackFailed, {
                        state: "error",
                        error: error,
                        message: `Player Play was called, current Queue Song is unresolved, but couldn't resolve it`,
                        functionLayer: "Player > play() > resolve currentTrack",
                    });
                }
                this.LavalinkManager.emit("trackError", this, this.queue.current, error);
                if (options && "clientTrack" in options)
                    delete options.clientTrack;
                if (options && "track" in options)
                    delete options.track;
                // try to play the next track if possible
                if (this.LavalinkManager.options?.autoSkipOnResolveError === true && this.queue.tracks[0])
                    return this.play(options);
                return this;
            }
        }
        if (!this.queue.current)
            throw new Error(`There is no Track in the Queue, nor provided in the PlayOptions`);
        if (typeof options?.volume === "number" && !isNaN(options?.volume)) {
            this.volume = Math.max(Math.min(options?.volume, 500), 0);
            let vol = Number(this.volume);
            if (this.LavalinkManager.options.playerOptions.volumeDecrementer)
                vol *= this.LavalinkManager.options.playerOptions.volumeDecrementer;
            this.lavalinkVolume = Math.round(vol);
            options.volume = this.lavalinkVolume;
        }
        const finalOptions = Object.fromEntries(Object.entries({
            track: {
                encoded: this.queue.current?.encoded || null,
                // identifier: options.identifier,
                userData: options?.track?.userData || {},
            },
            volume: this.lavalinkVolume,
            position: options?.position ?? 0,
            endTime: options?.endTime ?? undefined,
            filters: options?.filters ?? undefined,
            paused: options?.paused ?? undefined,
            voice: options?.voice ?? undefined
        }).filter(v => typeof v[1] !== "undefined"));
        if ((typeof finalOptions.position !== "undefined" && isNaN(finalOptions.position)) || (typeof finalOptions.position === "number" && (finalOptions.position < 0 || finalOptions.position >= this.queue.current.info.duration)))
            throw new Error("PlayerOption#position must be a positive number, less than track's duration");
        if ((typeof finalOptions.volume !== "undefined" && isNaN(finalOptions.volume) || (typeof finalOptions.volume === "number" && finalOptions.volume < 0)))
            throw new Error("PlayerOption#volume must be a positive number");
        if ((typeof finalOptions.endTime !== "undefined" && isNaN(finalOptions.endTime)) || (typeof finalOptions.endTime === "number" && (finalOptions.endTime < 0 || finalOptions.endTime >= this.queue.current.info.duration)))
            throw new Error("PlayerOption#endTime must be a positive number, less than track's duration");
        if (typeof finalOptions.position === "number" && typeof finalOptions.endTime === "number" && finalOptions.endTime < finalOptions.position)
            throw new Error("PlayerOption#endTime must be bigger than PlayerOption#position");
        const now = performance.now();
        await this.node.updatePlayer({
            guildId: this.guildId,
            noReplace: (options?.noReplace ?? false),
            playerOptions: finalOptions,
        });
        this.ping.lavalink = Math.round((performance.now() - now) / 10) / 100;
        return this;
    }
    /**
     * Set the Volume for the Player
     * @param volume The Volume in percent
     * @param ignoreVolumeDecrementer If it should ignore the volumedecrementer option
     */
    async setVolume(volume, ignoreVolumeDecrementer = false) {
        volume = Number(volume);
        if (isNaN(volume))
            throw new TypeError("Volume must be a number.");
        this.volume = Math.round(Math.max(Math.min(volume, 1000), 0));
        this.lavalinkVolume = Math.round(Math.max(Math.min(Math.round(this.LavalinkManager.options.playerOptions.volumeDecrementer && !ignoreVolumeDecrementer
            ? this.volume * this.LavalinkManager.options.playerOptions.volumeDecrementer
            : this.volume), 1000), 0));
        const now = performance.now();
        if (this.LavalinkManager.options.playerOptions.applyVolumeAsFilter) {
            if (typeof this.options.node === "string" && this.LavalinkManager.options?.advancedOptions?.enableDebugEvents) {
                this.LavalinkManager.emit("debug", Constants_1.DebugEvents.PlayerVolumeAsFilter, {
                    state: "log",
                    message: `Player Volume was set as a Filter, because LavalinkManager option "playerOptions.applyVolumeAsFilter" is true`,
                    functionLayer: "Player > setVolume()",
                });
            }
            await this.node.updatePlayer({ guildId: this.guildId, playerOptions: { filters: { volume: this.lavalinkVolume / 100 } } });
        }
        else {
            await this.node.updatePlayer({ guildId: this.guildId, playerOptions: { volume: this.lavalinkVolume } });
        }
        this.ping.lavalink = Math.round((performance.now() - now) / 10) / 100;
        return this;
    }
    /**
     * Search for a track
     * @param query The query to search for
     * @param requestUser The user that requested the track
     * @param throwOnEmpty If an error should be thrown if no track is found
     * @returns The search result
     */
    async lavaSearch(query, requestUser, throwOnEmpty = false) {
        return this.node.lavaSearch(query, requestUser, throwOnEmpty);
    }
    /**
     * Set the SponsorBlock
     * @param segments The segments to set
     */
    async setSponsorBlock(segments = ["sponsor", "selfpromo"]) {
        return this.node.setSponsorBlock(this, segments);
    }
    /**
     * Get the SponsorBlock
     */
    async getSponsorBlock() {
        return this.node.getSponsorBlock(this);
    }
    /**
     * Delete the SponsorBlock
     */
    async deleteSponsorBlock() {
        return this.node.deleteSponsorBlock(this);
    }
    /**
     *
     * @param query Query for your data
     * @param requestUser
     */
    async search(query, requestUser, throwOnEmpty = false) {
        const Query = this.LavalinkManager.utils.transformQuery(query);
        if (["bcsearch", "bandcamp"].includes(Query.source) && !this.node.info.sourceManagers.includes("bandcamp")) {
            if (typeof this.options.node === "string" && this.LavalinkManager.options?.advancedOptions?.enableDebugEvents) {
                this.LavalinkManager.emit("debug", Constants_1.DebugEvents.BandcampSearchLokalEngine, {
                    state: "log",
                    message: `Player.search was called with a Bandcamp Query, but no bandcamp search was enabled on lavalink, searching with the custom Search Engine.`,
                    functionLayer: "Player > search()",
                });
            }
            return await (0, BandCampSearch_1.bandCampSearch)(this, Query.query, requestUser);
        }
        return this.node.search(Query, requestUser, throwOnEmpty);
    }
    /**
     * Pause the player
     */
    async pause() {
        if (this.paused && !this.playing)
            throw new Error("Player is already paused - not able to pause.");
        this.paused = true;
        this.lastPositionChange = null; // needs to removed to not cause issues
        const now = performance.now();
        await this.node.updatePlayer({ guildId: this.guildId, playerOptions: { paused: true } });
        this.ping.lavalink = Math.round((performance.now() - now) / 10) / 100;
        return this;
    }
    /**
     * Resume the Player
     */
    async resume() {
        if (!this.paused)
            throw new Error("Player isn't paused - not able to resume.");
        this.paused = false;
        const now = performance.now();
        await this.node.updatePlayer({ guildId: this.guildId, playerOptions: { paused: false } });
        this.ping.lavalink = Math.round((performance.now() - now) / 10) / 100;
        return this;
    }
    /**
     * Seek to a specific Position
     * @param position
     */
    async seek(position) {
        if (!this.queue.current)
            return undefined;
        position = Number(position);
        if (isNaN(position))
            throw new RangeError("Position must be a number.");
        if (!this.queue.current.info.isSeekable || this.queue.current.info.isStream)
            throw new RangeError("Current Track is not seekable / a stream");
        if (position < 0 || position > this.queue.current.info.duration)
            position = Math.max(Math.min(position, this.queue.current.info.duration), 0);
        this.lastPositionChange = Date.now();
        this.lastPosition = position;
        const now = performance.now();
        await this.node.updatePlayer({ guildId: this.guildId, playerOptions: { position } });
        this.ping.lavalink = Math.round((performance.now() - now) / 10) / 100;
        return this;
    }
    /**
     * Set the Repeatmode of the Player
     * @param repeatMode
     */
    async setRepeatMode(repeatMode) {
        if (!["off", "track", "queue"].includes(repeatMode))
            throw new RangeError("Repeatmode must be either 'off', 'track', or 'queue'");
        this.repeatMode = repeatMode;
        return this;
    }
    /**
     * Skip the current song, or a specific amount of songs
     * @param amount provide the index of the next track to skip to
     */
    async skip(skipTo = 0, throwError = true) {
        if (!this.queue.tracks.length && (throwError || (typeof skipTo === "boolean" && skipTo === true)))
            throw new RangeError("Can't skip more than the queue size");
        if (typeof skipTo === "number" && skipTo > 1) {
            if (skipTo > this.queue.tracks.length)
                throw new RangeError("Can't skip more than the queue size");
            await this.queue.splice(0, skipTo - 1);
        }
        if (!this.playing)
            return (this.play(), this);
        const now = performance.now();
        this.set("internal_skipped", true);
        await this.node.updatePlayer({ guildId: this.guildId, playerOptions: { track: { encoded: null } } });
        this.ping.lavalink = Math.round((performance.now() - now) / 10) / 100;
        return this;
    }
    /**
     * Clears the queue and stops playing. Does not destroy the Player and not leave the channel
     * @returns
     */
    async stopPlaying(clearQueue = true, executeAutoplay = false) {
        // use internal_stopPlaying on true, so that it doesn't utilize current loop states. on trackEnd event
        this.set("internal_stopPlaying", true);
        // remove tracks from the queue
        if (this.queue.tracks.length && clearQueue === true)
            await this.queue.splice(0, this.queue.tracks.length);
        if (executeAutoplay === false)
            this.set("internal_autoplayStopPlaying", true);
        else
            this.set("internal_autoplayStopPlaying", undefined);
        const now = performance.now();
        // send to lavalink, that it should stop playing
        await this.node.updatePlayer({ guildId: this.guildId, playerOptions: { track: { encoded: null } } });
        this.ping.lavalink = Math.round((performance.now() - now) / 10) / 100;
        return this;
    }
    /**
     * Connects the Player to the Voice Channel
     * @returns
     */
    async connect() {
        if (!this.options.voiceChannelId)
            throw new RangeError("No Voice Channel id has been set. (player.options.voiceChannelId)");
        await this.LavalinkManager.options.sendToShard(this.guildId, {
            op: 4,
            d: {
                guild_id: this.guildId,
                channel_id: this.options.voiceChannelId,
                self_mute: this.options.selfMute ?? false,
                self_deaf: this.options.selfDeaf ?? true,
            }
        });
        this.voiceChannelId = this.options.voiceChannelId;
        return this;
    }
    async changeVoiceState(data) {
        if (this.options.voiceChannelId === data.voiceChannelId)
            throw new RangeError("New Channel can't be equal to the old Channel.");
        await this.LavalinkManager.options.sendToShard(this.guildId, {
            op: 4,
            d: {
                guild_id: this.guildId,
                channel_id: data.voiceChannelId,
                self_mute: data.selfMute ?? this.options.selfMute ?? false,
                self_deaf: data.selfDeaf ?? this.options.selfDeaf ?? true,
            }
        });
        // override the options
        this.options.voiceChannelId = data.voiceChannelId;
        this.options.selfMute = data.selfMute;
        this.options.selfDeaf = data.selfDeaf;
        this.voiceChannelId = data.voiceChannelId;
        return this;
    }
    /**
     * Disconnects the Player from the Voice Channel, but keeps the player in the cache
     * @param force If false it throws an error, if player thinks it's already disconnected
     * @returns
     */
    async disconnect(force = false) {
        if (!force && !this.options.voiceChannelId)
            throw new RangeError("No Voice Channel id has been set. (player.options.voiceChannelId)");
        await this.LavalinkManager.options.sendToShard(this.guildId, {
            op: 4,
            d: {
                guild_id: this.guildId,
                channel_id: null,
                self_mute: false,
                self_deaf: false,
            }
        });
        this.voiceChannelId = null;
        return this;
    }
    /**
     * Destroy the player and disconnect from the voice channel
     */
    async destroy(reason, disconnect = true) {
        if (this.LavalinkManager.options.advancedOptions?.debugOptions.playerDestroy.debugLog)
            console.log(`Lavalink-Client-Debug | PlayerDestroy [::] destroy Function, [guildId ${this.guildId}] - Destroy-Reason: ${String(reason)}`);
        if (this.get("internal_destroystatus") === true) {
            if (this.LavalinkManager.options?.advancedOptions?.enableDebugEvents) {
                this.LavalinkManager.emit("debug", Constants_1.DebugEvents.PlayerDestroyingSomewhereElse, {
                    state: "warn",
                    message: `Player is already destroying somewhere else..`,
                    functionLayer: "Player > destroy()",
                });
            }
            if (this.LavalinkManager.options.advancedOptions?.debugOptions.playerDestroy.debugLog)
                console.log(`Lavalink-Client-Debug | PlayerDestroy [::] destroy Function, [guildId ${this.guildId}] - Already destroying somewhere else..`);
            return;
        }
        this.set("internal_destroystatus", true);
        // disconnect player and set VoiceChannel to Null
        if (disconnect)
            await this.disconnect(true);
        else
            this.set("internal_destroywithoutdisconnect", true);
        // Destroy the queue
        await this.queue.utils.destroy();
        // delete the player from cache
        this.LavalinkManager.deletePlayer(this.guildId);
        // destroy the player on lavalink side
        await this.node.destroyPlayer(this.guildId);
        if (this.LavalinkManager.options.advancedOptions?.debugOptions.playerDestroy.debugLog)
            console.log(`Lavalink-Client-Debug | PlayerDestroy [::] destroy Function, [guildId ${this.guildId}] - Player got destroyed successfully`);
        // emit the event
        this.LavalinkManager.emit("playerDestroy", this, reason);
        // return smt
        return this;
    }
    /**
     * Move the player on a different Audio-Node
     * @param newNode New Node / New Node Id
     */
    async changeNode(newNode) {
        const updateNode = typeof newNode === "string" ? this.LavalinkManager.nodeManager.nodes.get(newNode) : newNode;
        if (!updateNode)
            throw new Error("Could not find the new Node");
        if (typeof this.options.node === "string" && this.LavalinkManager.options?.advancedOptions?.enableDebugEvents) {
            this.LavalinkManager.emit("debug", Constants_1.DebugEvents.PlayerChangeNode, {
                state: "log",
                message: `Player.changeNode() was executed, trying to change from "${this.node.id}" to "${updateNode.id}"`,
                functionLayer: "Player > changeNode()",
            });
        }
        const data = this.toJSON();
        const currentTrack = this.queue.current;
        await this.node.destroyPlayer(this.guildId);
        this.node = updateNode;
        const now = performance.now();
        await this.connect();
        await this.node.updatePlayer({
            guildId: this.guildId,
            noReplace: false,
            playerOptions: {
                position: data.position,
                volume: Math.round(Math.max(Math.min(data.volume, 1000), 0)),
                paused: data.paused,
                filters: { ...data.filters, equalizer: data.equalizer },
                track: currentTrack ?? undefined
            },
        });
        this.ping.lavalink = Math.round((performance.now() - now) / 10) / 100;
        return this.node.id;
    }
    /** Converts the Player including Queue to a Json state */
    toJSON() {
        return {
            guildId: this.guildId,
            options: this.options,
            voiceChannelId: this.voiceChannelId,
            textChannelId: this.textChannelId,
            position: this.position,
            lastPosition: this.lastPosition,
            lastPositionChange: this.lastPositionChange,
            volume: this.volume,
            lavalinkVolume: this.lavalinkVolume,
            repeatMode: this.repeatMode,
            paused: this.paused,
            playing: this.playing,
            createdTimeStamp: this.createdTimeStamp,
            filters: this.filterManager?.data || {},
            equalizer: this.filterManager?.equalizerBands || [],
            nodeId: this.node?.id,
            nodeSessionId: this.node?.sessionId,
            ping: this.ping,
            queue: this.queue.utils.toJSON(),
        };
    }
}
exports.Player = Player;
