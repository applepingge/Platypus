/**
 * This component handles rendering tile map backgrounds.
 *
 * When rendering the background, this component figures out what tiles are being displayed and caches them so they are rendered as one image rather than individually.
 *
 * As the camera moves, the cache is updated by blitting the relevant part of the old cached image into a new cache and then rendering tiles that have shifted into the camera's view into the cache.
 *
 * @namespace platypus.components
 * @class RenderTiles
 * @uses platypus.Component
 */
/* global include, platypus, recycle, springroll */
(function () {
    'use strict';

    var EDGE_BLEED = 1,
        EDGES_BLEED = EDGE_BLEED * 2,
        AABB              = include('platypus.AABB'),
        PIXIAnimation     = include('platypus.PIXIAnimation'),
        Application       = include('springroll.Application'),
        CanvasRenderer    = include('PIXI.CanvasRenderer'),
        Container         = include('PIXI.Container'),
        Graphics          = include('PIXI.Graphics'),
        ParticleContainer = Container, //Excluding ParticleContainer atm due to https://github.com/pixijs/pixi.js/issues/4008 -- include('PIXI.particles.ParticleContainer'),
        Rectangle         = include('PIXI.Rectangle'),
        RenderTexture     = include('PIXI.RenderTexture'),
        Sprite            = include('PIXI.Sprite'),
        clearRenderTexture = function (renderer, renderTexture, clearColor) { // This is pulled from https://github.com/pixijs/pixi.js/pull/3647 and should be in a future build of PIXI
            var baseTexture = renderTexture.baseTexture,
                renderTarget = baseTexture._glRenderTargets[renderer.CONTEXT_UID];
                
            if (renderTarget) {
                renderTarget.clear(clearColor);
            }
        },
        doNothing = function () {
            return null;
        },
        tempCache = AABB.setUp(),
        sort = function (a, b) {
            return a.z - b.z;
        },
        getPowerOfTwo = function (amount) {
            var x = 1;

            while (x < amount) {
                x *= 2;
            }

            return x;
        },
        transformCheck = function (value, tile) {
            var v = +(value.substring(4)),
                x = 0;

            if (0x80000000 & v) {
                tile.scale.x = -1;
            }
            if (0x40000000 & v) {
                tile.scale.y = -1;
            }
            if (0x20000000 & v) {
                x = tile.scale.x;
                tile.scale.x = tile.scale.y;
                tile.scale.y = -x;
                tile.rotation = Math.PI / 2;
            }

            return 0x0fffffff & v;
        },
        Template = function (tile, id) {
            this.id = id;
            this.instances = Array.setUp(tile);
            this.index = 0;
            tile.template = this; // backwards reference for clearing index later.
        },
        nullTemplate = {
            getNext: doNothing,
            destroy: doNothing
        },
        prototype = Template.prototype;

    prototype.getNext = function () {
        var instance = this.instances[this.index],
            template = null;

        if (!instance) {
            template = this.instances[0];
            instance = this.instances[this.index] = new Sprite(template.texture);

            // Copy properties
            instance.scale    = template.scale;
            instance.rotation = template.rotation;
            instance.anchor   = template.anchor;
        }

        this.index += 1;

        return instance;
    };

    prototype.clear = function () {
        this.index = 0;
    };
    
    prototype.destroy = function () {
        var i = 0;
        
        for (i = 0; i < this.instances.length; i++) {
            this.instances[i].destroy();
        }
        
        this.instances.recycle();
        this.recycle();
    };

    recycle.add(Template, !!springroll.Debug, 'Template');

    return platypus.createComponentClass({

        id: 'RenderTiles',

        properties: {
            /**
             * The amount of space in pixels around the edge of the camera that we include in the buffered image. If not set, largest buffer allowed by maximumBuffer is used.
             *
             * @property buffer
             * @type number
             * @default 0
             */
            buffer: 0,

            /**
             * Determines whether to cache the entire map across one or more texture caches. By default this is `false`; however, if the entire map fits on one or two texture caches, this is set to `true` since it is more efficient than dynamic buffering.
             *
             * @property cacheAll
             * @type Boolean
             * @default false
             */
            cacheAll: false,

            /**
             * Whether to cache entities on this layer if the entity's render component requests caching.
             *
             * @property entityCache
             * @type boolean
             * @default false
             */
            entityCache: false,

            /**
             * This is a two dimensional array of the spritesheet indexes that describe the map that you're rendering.
             *
             * @property imageMap
             * @type Array
             * @default []
             */
            imageMap: [],

            /**
             * The amount of space that is buffered. Defaults to 2048 x 2048 or a smaller area that encloses the tile layer.
             *
             * @property maximumBuffer
             * @type number
             * @default 2048
             */
            maximumBuffer: 2048,

            /**
             * The x-scale the tilemap is being displayed at.
             *
             * @property scaleX
             * @type number
             * @default 1
             */
            scaleX: 1,

            /**
             * The y-scale the tilemap is being displayed at.
             *
             * @property scaleY
             * @type number
             * @default 1
             */
            scaleY: 1,

            /**
             * A sprite sheet describing all the tile images.
             *
             * Accepts an array of sprite sheet data since 0.8.4
             *
             * @property spriteSheet
             * @type Object|Array|String
             * @default null
             */
            spriteSheet: null,

            /**
             * Whether to cache the tile map to a large texture.
             *
             * @property tileCache
             * @type boolean
             * @default true
             * @since 0.6.4
             */
            tileCache: true,

            /**
             * This is the height in pixels of individual tiles.
             *
             * @property tileHeight
             * @type number
             * @default 10
             */
            tileHeight: 10,

            /**
             * This is the width in pixels of individual tiles.
             *
             * @property tileWidth
             * @type number
             * @default 10
             */
            tileWidth: 10,
            
            /**
             * The map's top offset.
             *
             * @property top
             * @type Number
             * @default 0
             * @since 0.7.5
             */
            top: 0,
            
            /**
             * The map's left offset.
             *
             * @property left
             * @type Number
             * @default 0
             * @since 0.7.5
             */
            left: 0
        },

        initialize: function () {
            var imgMap = this.imageMap;

            this.doMap            = null; //list of display objects that should overlay tile map.
            this.cachedDisplayObjects = null;
            this.populate         = this.populateTiles;

            this.tiles            = {};

            this.renderer         = Application.instance.display.renderer;
            this.tilesSprite      = null;
            this.cacheTexture     = null;
            this.mapContainer      = null;
            this.laxCam = AABB.setUp();

            // temp values
            this.worldWidth    = this.tileWidth;
            this.worldHeight   = this.tileHeight;

            this.cache = AABB.setUp();
            this.cachePixels = AABB.setUp();

            // Set up containers
            this.spriteSheet = PIXIAnimation.formatSpriteSheet(this.spriteSheet);
            this.tileContainer = ((this.spriteSheet.images.length > 1) || (this.renderer instanceof CanvasRenderer)) ? new Container() : new ParticleContainer(15000, {position: true, rotation: true, scale: true});
            this.mapContainer = new Container();
            this.mapContainer.addChild(this.tileContainer);
            
            this.reorderedStage = false;
            this.updateCache = false;

            // Prepare map tiles
            this.imageMap = Array.setUp(this.createMap(imgMap));

            this.tilesWidth  = this.imageMap[0].length;
            this.tilesHeight = this.imageMap[0][0].length;
            this.layerWidth  = this.tilesWidth  * this.tileWidth;
            this.layerHeight = this.tilesHeight * this.tileHeight;

            // Set up buffer cache size
            this.cacheWidth  = Math.min(getPowerOfTwo(this.layerWidth  + EDGES_BLEED), this.maximumBuffer);
            this.cacheHeight = Math.min(getPowerOfTwo(this.layerHeight + EDGES_BLEED), this.maximumBuffer);

            if (!this.tileCache) {
                this.buffer = 0; // prevents buffer logic from running if tiles aren't being cached.
                this.cacheAll = false; // so tiles are updated as camera moves.
            }

            this.ready = false;
        },

        events: {
            /**
             * This event is triggered before `handle-render` and provides the container that this component will require to display. In this case it compiles the array of tiles that make up the map and adds the tilesSprite displayObject to the stage.
             *
             * @method 'handle-render-load'
             * @param data.container {PIXI.Container} Container to contain this tile-rendering.
             */
            "handle-render-load": function (resp) {
                var extrusionMargin = 2,
                    mapContainer = this.mapContainer,
                    parentContainer = null,
                    sprite = null,
                    z = this.owner.z;

                if (resp && resp.container) {
                    this.ready = true;
                    parentContainer = this.parentContainer = resp.container;

                    if (parentContainer && !this.reorderedStage) {
                        parentContainer.reorder = true;
                        this.reorderedStage = true;
                    }

                    this.updateRegion(0);

                    if (!this.tileCache) {
                        this.render = doNothing;

                        mapContainer.scale.x = this.scaleX;
                        mapContainer.scale.y = this.scaleY;
                        mapContainer.x = this.left;
                        mapContainer.y = this.top;
                        mapContainer.z = z;
                        parentContainer.addChild(mapContainer);
                    } else {
                        this.mapContainerWrapper = new Container();
                        this.mapContainerWrapper.addChild(mapContainer);

                        if ((this.layerWidth <= this.cacheWidth) && (this.layerHeight <= this.cacheHeight)) { // We never need to recache.
                            this.cacheAll   = true;

                            this.render = this.renderCache;
                            this.cacheTexture = RenderTexture.create(this.cacheWidth, this.cacheHeight);

                            this.tilesSprite = sprite = new Sprite(this.cacheTexture);
                            sprite.scale.x = this.scaleX;
                            sprite.scale.y = this.scaleY;
                            sprite.z = z;

                            this.cache.setBounds(0, 0, this.tilesWidth - 1, this.tilesHeight - 1);
                            this.update(this.cacheTexture, this.cache);
                            parentContainer.addChild(sprite);
                        } else if (this.cacheAll || ((this.layerWidth <= this.cacheWidth * 2) && (this.layerHeight <= this.cacheHeight)) || ((this.layerWidth <= this.cacheWidth) && (this.layerHeight <= this.cacheHeight * 2))) { // We cache everything across several textures creating a cache grid.
                            this.cacheAll = true;

                            // Make sure there's room for the one-pixel extrusion around edges of caches
                            this.cacheWidth = Math.min(getPowerOfTwo(this.layerWidth + extrusionMargin), this.maximumBuffer);
                            this.cacheHeight = Math.min(getPowerOfTwo(this.layerHeight + extrusionMargin), this.maximumBuffer);
                            this.updateRegion(extrusionMargin);

                            this.render = this.renderCacheWithExtrusion;
                            this.cacheGrid = this.createGrid(parentContainer);

                            this.updateCache = true;
                        } else {
                            this.render = this.renderCache;
                            this.cacheAll = false;

                            this.cacheTexture = RenderTexture.create(this.cacheWidth, this.cacheHeight);

                            this.tilesSprite = new Sprite(this.cacheTexture);
                            this.tilesSprite.scale.x = this.scaleX;
                            this.tilesSprite.scale.y = this.scaleY;
                            this.tilesSprite.z = z;

                            // Set up copy buffer and circular pointers
                            this.cacheTexture.alternate = RenderTexture.create(this.cacheWidth, this.cacheHeight);
                            this.tilesSpriteCache = new Sprite(this.cacheTexture.alternate);

                            this.cacheTexture.alternate.alternate = this.cacheTexture;
                            parentContainer.addChild(this.tilesSprite);
                        }
                    }
                }
            },

            /**
             * If this component should cache entities, it checks peers for a "renderCache" display object and adds the display object to its list of objects to render on top of the tile set.
             *
             * @method 'cache-sprite'
             * @param entity {platypus.Entity} This is the peer entity to be checked for a renderCache.
             */
            "cache-sprite": function (entity) {
                this.cacheSprite(entity);
            },

            /**
             * If this component should cache entities, it checks peers for a "renderCache" display object and adds the display object to its list of objects to render on top of the tile set.
             *
             * @method 'peer-entity-added'
             * @param entity {platypus.Entity} This is the peer entity to be checked for a renderCache.
             */
            "peer-entity-added": function (entity) {
                this.cacheSprite(entity);
            },

            /**
             * This event adds a layer of tiles to render on top of the existing layer of rendered tiles.
             *
             * @method 'add-tiles'
             * @param message.imageMap {Array} This is a 2D mapping of tile indexes to be rendered.
             */
            "add-tiles": function (definition) {
                var map = definition.imageMap;

                if (map) {
                    this.imageMap.push(this.createMap(map));
                    this.updateCache = true;
                }
            },

            /**
             * This event edits the tile index of a rendered tile.
             *
             * @method 'change-tile'
             * @param tile {String} A string representing the name of the tile to switch to.
             * @param x {Number} The column of the tile to edit.
             * @param y {Number} The row of the tile to edit.
             * @param [z] {Number} If RenderTiles has multiple layers, this value specifies the layer, with `0` being the bottom-most layer.
             */
            "change-tile": function (tile, x, y, z) {
                var map = this.imageMap;

                if (map) {
                    this.updateTile(tile, map[z || 0], x, y);
                    this.updateCache = true;
                }
            },

            /**
             * Provides the width and height of the world.
             *
             * @method 'camera-loaded'
             * @param camera {Object}
             * @param camera.world {platypus.AABB} The dimensions of the world.
             * @param camera.viewport {platypus.AABB} The AABB describing the camera viewport in world units.
             */
            "camera-loaded": function (camera) {
                this.worldWidth  = camera.world.width;
                this.worldHeight = camera.world.height;

                if (this.buffer && !this.cacheAll) { // do this here to set the correct mask before the first caching.
                    this.updateBufferRegion(camera.viewport);
                }
            },

            /**
             * Triggered when the camera moves, this function updates which tiles need to be rendered and caches the image.
             *
             * @method 'camera-update'
             * @param camera {Object} Provides information about the camera.
             * @param camera.viewport {platypus.AABB} The AABB describing the camera viewport in world units.
             */
            "camera-update": function (camera) {
                if (this.ready) {
                    this.updateCamera(camera);
                }
            },

            /**
             * On receiving this message, determines whether to update which tiles need to be rendered and caches the image.
             *
             * @method 'handle-render'
             */
            "handle-render": function () {
                if (this.updateCache) {
                    this.updateCache = false;
                    if (this.cacheGrid) {
                        this.updateGrid();
                    } else {
                        this.update(this.cacheTexture, this.cache);
                    }
                }
            }
        },

        methods: {
            cacheSprite: function (entity) {
                var x = 0,
                    y = 0,
                    object = entity.cacheRender,
                    bounds = null,
                    top = 0,
                    bottom = 0,
                    right = 0,
                    left = 0;

                // Determine whether to merge this image with the background.
                if (this.entityCache && object) { //TODO: currently only handles a single display object on the cached entity.
                    if (!this.doMap) {
                        this.doMap = Array.setUp();
                        this.cachedDisplayObjects = Array.setUp();
                        this.populate = this.populateTilesAndEntities;
                    }
                    this.cachedDisplayObjects.push(object);

                    // Determine range:
                    bounds = object.getBounds(object.transformMatrix);
                    bounds.x -= this.left;
                    bounds.y -= this.top;
                    top    = Math.max(0, Math.floor(bounds.y / this.tileHeight));
                    bottom = Math.min(this.tilesHeight, Math.ceil((bounds.y + bounds.height) / this.tileHeight));
                    left   = Math.max(0, Math.floor(bounds.x / this.tileWidth));
                    right  = Math.min(this.tilesWidth, Math.ceil((bounds.x + bounds.width) / this.tileWidth));

                    // Find tiles that should include this display object
                    for (x = left; x < right; x++) {
                        if (!this.doMap[x]) {
                            this.doMap[x] = Array.setUp();
                        }
                        for (y = top; y < bottom; y++) {
                            if (!this.doMap[x][y]) {
                                this.doMap[x][y] = Array.setUp();
                            }
                            this.doMap[x][y].push(object);
                        }
                    }

                    // Prevent subsequent draws
                    entity.removeComponent('RenderSprite');

                    this.updateCache = true; //TODO: This currently causes a blanket cache update - may be worthwhile to only recache if this entity's location is currently in a cache (either cacheGrid or the current viewable area).
                }
            },

            convertCamera: function (camera) {
                var worldWidth  = this.worldWidth / this.scaleX,
                    worldPosX   = worldWidth - camera.width,
                    worldHeight = this.worldHeight / this.scaleY,
                    worldPosY   = worldHeight - camera.height,
                    laxCam      = this.laxCam;

                if ((worldWidth === this.layerWidth) || !worldPosX) {
                    laxCam.moveX(camera.x);
                } else {
                    laxCam.moveX((camera.left - this.left) * (this.layerWidth - camera.width) / worldPosX + camera.halfWidth + this.left);
                }

                if ((worldHeight === this.layerHeight) || !worldPosY) {
                    laxCam.moveY(camera.y);
                } else {
                    laxCam.moveY((camera.top - this.top) * (this.layerHeight - camera.height) / worldPosY + camera.halfHeight + this.top);
                }

                if (camera.width !== laxCam.width || camera.height !== laxCam.height) {
                    laxCam.resize(camera.width, camera.height);
                }

                return laxCam;
            },

            createTile: function (imageName) {
                var tile = null,
                    anim = '';

                // "tile-1" is empty, so it remains a null reference.
                if (imageName === 'tile-1') {
                    return nullTemplate;
                }

                tile = new PIXIAnimation(this.spriteSheet);
                anim = 'tile' + transformCheck(imageName, tile);
                tile.gotoAndStop(anim);

                return Template.setUp(tile, imageName);
            },

            createMap: function (mapDefinition) {
                var x = 0,
                    y = 0,
                    index = '',
                    map   = null;

                if (typeof mapDefinition[0][0] !== 'string') { // This is not a map definition: it's an actual RenderTiles map.
                    return mapDefinition;
                }

                map = Array.setUp();
                for (x = 0; x < mapDefinition.length; x++) {
                    map[x] = Array.setUp();
                    for (y = 0; y < mapDefinition[x].length; y++) {
                        index = mapDefinition[x][y];
                        this.updateTile(index, map, x, y);
                    }
                }
                
                return map;
            },
            
            updateCamera: function (camera) {
                var x = 0,
                    y = 0,
                    inFrame = false,
                    sprite  = null,
                    ctw     = 0,
                    cth     = 0,
                    ctw2    = 0,
                    cth2    = 0,
                    cache   = this.cache,
                    cacheP  = this.cachePixels,
                    vp      = camera.viewport,
                    resized = (this.buffer && ((vp.width !== this.laxCam.width) || (vp.height !== this.laxCam.height))),
                    tempC   = tempCache,
                    laxCam  = this.convertCamera(vp);

                if (!this.cacheAll && (cacheP.empty || !cacheP.contains(laxCam)) && (this.imageMap.length > 0)) {
                    if (resized) {
                        this.updateBufferRegion(laxCam);
                    }
                    ctw     = this.cacheTilesWidth - 1;
                    cth     = this.cacheTilesHeight - 1;
                    ctw2    = ctw / 2;
                    cth2    = cth / 2;

                    //only attempt to draw children that are relevant
                    tempC.setAll(Math.round((laxCam.x - this.left) / this.tileWidth - ctw2) + ctw2, Math.round((laxCam.y - this.top) / this.tileHeight - cth2) + cth2, ctw, cth);
                    if (tempC.left < 0) {
                        tempC.moveX(tempC.halfWidth);
                    } else if (tempC.right > this.tilesWidth - 1) {
                        tempC.moveX(this.tilesWidth - 1 - tempC.halfWidth);
                    }
                    if (tempC.top < 0) {
                        tempC.moveY(tempC.halfHeight);
                    } else if (tempC.bottom > this.tilesHeight - 1) {
                        tempC.moveY(this.tilesHeight - 1 - tempC.halfHeight);
                    }
                    
                    if (!this.tileCache) {
                        this.update(null, tempC);
                    } else if (cache.empty || !tempC.contains(cache)) {
                        this.tilesSpriteCache.texture = this.cacheTexture;
                        this.cacheTexture = this.cacheTexture.alternate;
                        this.tilesSprite.texture = this.cacheTexture;
                        this.update(this.cacheTexture, tempC, this.tilesSpriteCache, cache);
                    }

                    // Store pixel bounding box for checking later.
                    cacheP.setAll((cache.x + 0.5) * this.tileWidth + this.left, (cache.y + 0.5) * this.tileHeight + this.top, (cache.width + 1) * this.tileWidth, (cache.height + 1) * this.tileHeight);
                }

                if (this.cacheGrid) {
                    for (x = 0; x < this.cacheGrid.length; x++) {
                        for (y = 0; y < this.cacheGrid[x].length; y++) {
                            sprite = this.cacheGrid[x][y];
                            cacheP.setAll((x + 0.5) * this.cacheClipWidth + this.left, (y + 0.5) * this.cacheClipHeight + this.top, this.cacheClipWidth, this.cacheClipHeight);

                            inFrame = cacheP.intersects(laxCam);
                            if (sprite.visible && !inFrame) {
                                sprite.visible = false;
                            } else if (!sprite.visible && inFrame) {
                                sprite.visible = true;
                            }
                            
                            if (sprite.visible && inFrame) {
                                sprite.x = vp.left - laxCam.left + x * this.cacheClipWidth + this.left;
                                sprite.y = vp.top  - laxCam.top  + y * this.cacheClipHeight + this.top;
                            }
                        }
                    }
                } else if (this.tileCache) {
                    this.tilesSprite.x = vp.left - laxCam.left + cache.left * this.tileWidth + this.left;
                    this.tilesSprite.y = vp.top  - laxCam.top  + cache.top  * this.tileHeight + this.top;
                }
            },

            updateTile: function (index, map, x, y) {
                var tile = null,
                    tiles = this.tiles;
                
                if (index.id) {
                    index = index.id;
                }
                tile = tiles[index];
                if (!tile && (tile !== null)) { // Empty grid spaces are null, so we needn't create a new tile.
                    tile = tiles[index] = this.createTile(index);
                }
                map[x][y] = tile;
            },

            createGrid: function (parentContainer) {
                var ch = this.cacheHeight,
                    cw = this.cacheWidth,
                    cth = this.cacheTilesHeight,
                    ctw = this.cacheTilesWidth,
                    h = 0,
                    w = 0,
                    outerMargin = EDGES_BLEED,
                    extrusion = EDGE_BLEED,
                    rt = null,
                    sx = this.scaleX,
                    sy = this.scaleY,
                    th = this.tileHeight,
                    tw = this.tileWidth,
                    tsh = this.tilesHeight,
                    tsw = this.tilesWidth,
                    x = 0,
                    y = 0,
                    z = this.owner.z,
                    col = null,
                    ct = null,
                    cg = Array.setUp();

                for (x = 0; x < tsw; x += ctw) {
                    col = Array.setUp();
                    cg.push(col);
                    for (y = 0; y < tsh; y += cth) {
                        // This prevents us from using too large of a cache for the right and bottom edges of the map.
                        w = Math.min(getPowerOfTwo((tsw - x) * tw + outerMargin), cw);
                        h = Math.min(getPowerOfTwo((tsh - y) * th + outerMargin), ch);

                        rt = RenderTexture.create(w, h);
                        rt.frame = new Rectangle(extrusion, extrusion, (((w - outerMargin) / tw) >> 0) * tw + extrusion, (((h - outerMargin) / th) >> 0) * th + extrusion);
                        ct = new Sprite(rt);
                        ct.z = z;
                        ct.scale.x = sx;
                        ct.scale.y = sy;
                        col.push(ct);
                        parentContainer.addChild(ct);

                        z -= 0.000001; // so that tiles of large caches overlap consistently.
                    }
                }
                
                return cg;
            },
            
            updateRegion: function (margin) {
                var tw = this.tileWidth * this.scaleX,
                    th = this.tileHeight * this.scaleY,
                    ctw = Math.min(this.tilesWidth,  ((this.cacheWidth - EDGES_BLEED)  / tw)  >> 0),
                    cth = Math.min(this.tilesHeight, ((this.cacheHeight - EDGES_BLEED) / th) >> 0);

                if (!ctw) {
                    platypus.debug.warn('"' + this.owner.type + '" RenderTiles: The tiles are ' + tw + 'px wide which is larger than ' + (this.cacheWidth - EDGES_BLEED) + 'px (maximum cache size of ' + this.cacheWidth + 'px minus a 2px edge bleed). Increase the maximum cache size or reduce tile size.');
                }
                if (!cth) {
                    platypus.debug.warn('"' + this.owner.type + '" RenderTiles: The tiles are ' + th + 'px high which is larger than ' + (this.cacheHeight - EDGES_BLEED) + 'px (maximum cache size of ' + this.cacheHeight + 'px minus a 2px edge bleed). Increase the maximum cache size or reduce tile size.');
                }

                this.cacheTilesWidth  = ctw;
                this.cacheTilesHeight = cth;
                this.cacheClipWidth   = ctw * tw;
                this.cacheClipHeight  = cth * th;

                if (this.tileCache) {
                    this.mapContainer.mask = new Graphics().beginFill(0x000000).drawRect(0, 0, this.cacheClipWidth + margin, this.cacheClipHeight + margin).endFill();
                }
            },

            updateBufferRegion: function (viewport) {
                var tw = this.tileWidth * this.scaleX,
                    th = this.tileHeight * this.scaleY;

                this.cacheTilesWidth  = Math.min(this.tilesWidth,  Math.ceil((viewport.width  + this.buffer * 2) / tw), (this.cacheWidth  / tw) >> 0);
                this.cacheTilesHeight = Math.min(this.tilesHeight, Math.ceil((viewport.height + this.buffer * 2) / th), (this.cacheHeight / th) >> 0);

                this.cacheClipWidth   = this.cacheTilesWidth  * tw;
                this.cacheClipHeight  = this.cacheTilesHeight * th;

                this.mapContainer.mask = new Graphics().beginFill(0x000000).drawRect(0, 0, this.cacheClipWidth, this.cacheClipHeight).endFill();
            },

            update: function (texture, bounds, tilesSpriteCache, oldBounds) {
                this.populate(bounds, oldBounds);

                this.render(bounds, texture, this.mapContainer, this.mapContainerWrapper, tilesSpriteCache, oldBounds);

                if (oldBounds) {
                    oldBounds.set(bounds);
                }
            },
            
            populateTiles: function (bounds, oldBounds) {
                var x = 0,
                    y = 0,
                    z = 0,
                    layer = 0,
                    tile  = null,
                    tiles = Array.setUp();

                this.tileContainer.removeChildren();
                for (x = bounds.left; x <= bounds.right; x++) {
                    for (y = bounds.top; y <= bounds.bottom; y++) {
                        if (!oldBounds || oldBounds.empty || (y > oldBounds.bottom) || (y < oldBounds.top) || (x > oldBounds.right) || (x < oldBounds.left)) {
                            for (layer = 0; layer < this.imageMap.length; layer++) {
                                tile = this.imageMap[layer][x][y].getNext();
                                if (tile) {
                                    if (tile.template) {
                                        tiles.push(tile.template);
                                    }
                                    tile.x = (x + 0.5) * this.tileWidth;
                                    tile.y = (y + 0.5) * this.tileHeight;
                                    this.tileContainer.addChild(tile);
                                }
                            }
                        }
                    }
                }

                // Clear out tile instances
                for (z = 0; z < tiles.length; z++) {
                    tiles[z].clear();
                }
                tiles.recycle();
            },
            
            populateTilesAndEntities: function (bounds, oldBounds) {
                var x = 0,
                    y = 0,
                    z = 0,
                    layer   = 0,
                    tile    = null,
                    ent     = null,
                    ents    = Array.setUp(),
                    tiles   = Array.setUp(),
                    oList   = null;

                this.tileContainer.removeChildren();
                for (x = bounds.left; x <= bounds.right; x++) {
                    for (y = bounds.top; y <= bounds.bottom; y++) {
                        if (!oldBounds || oldBounds.empty || (y > oldBounds.bottom) || (y < oldBounds.top) || (x > oldBounds.right) || (x < oldBounds.left)) {
                            // draw tiles
                            for (layer = 0; layer < this.imageMap.length; layer++) {
                                tile = this.imageMap[layer][x][y].getNext();
                                if (tile) {
                                    if (tile.template) {
                                        tiles.push(tile.template);
                                    }
                                    tile.x = (x + 0.5) * this.tileWidth;
                                    tile.y = (y + 0.5) * this.tileHeight;
                                    this.tileContainer.addChild(tile);
                                }
                            }

                            // check for cached entities
                            if (this.doMap[x] && this.doMap[x][y]) {
                                oList = this.doMap[x][y];
                                for (z = 0; z < oList.length; z++) {
                                    if (!oList[z].drawn) {
                                        oList[z].drawn = true;
                                        ents.push(oList[z]);
                                    }
                                }
                            }
                        }
                    }
                }

                this.mapContainer.removeChildren();
                this.mapContainer.addChild(this.tileContainer);

                // Draw cached entities
                if (ents.length) {
                    ents.sort(sort);
                    for (z = 0; z < ents.length; z++) {
                        ent = ents[z];
                        delete ent.drawn;
                        this.mapContainer.addChild(ent);
                        if (ent.mask) {
                            this.mapContainer.addChild(ent.mask);
                        }
                    }
                }

                // Clear out tile instances
                for (z = 0; z < tiles.length; z++) {
                    tiles[z].clear();
                }
                
                tiles.recycle();
                ents.recycle();
            },
            
            renderCache: function (bounds, dest, src, wrapper, oldCache, oldBounds) {
                var renderer = this.renderer;

                if (oldCache && !oldBounds.empty) {
                    oldCache.x = oldBounds.left * this.tileWidth;
                    oldCache.y = oldBounds.top * this.tileHeight;
                    src.addChild(oldCache); // To copy last rendering over.
                }

                clearRenderTexture(renderer, dest);
                src.x = -bounds.left * this.tileWidth;
                src.y = -bounds.top * this.tileHeight;
                renderer.render(wrapper, dest);
                dest.requiresUpdate = true;
            },

            renderCacheWithExtrusion: function (bounds, dest, src, wrapper) {
                var extrusion = 1,
                    border = new Graphics(),
                    renderer = this.renderer;

                // This mask makes only the extruded border drawn for the next 4 draws so that inner holes aren't extruded in addition to the outer rim.
                border.lineStyle(1, 0x000000);
                border.drawRect(0.5, 0.5, this.cacheClipWidth + 1, this.cacheClipHeight + 1);

                clearRenderTexture(renderer, dest);

                // There is probably a better way to do this. Currently for the extrusion, everything is rendered once offset in the n, s, e, w directions and then once in the middle to create the effect.
                wrapper.mask = border;
                src.x = -bounds.left * this.tileWidth;
                src.y = -bounds.top * this.tileHeight + extrusion;
                renderer.render(wrapper, dest);
                src.x = -bounds.left * this.tileWidth + extrusion;
                src.y = -bounds.top * this.tileHeight;
                renderer.render(wrapper, dest);
                src.x = -bounds.left * this.tileWidth + extrusion * 2;
                src.y = -bounds.top * this.tileHeight + extrusion;
                renderer.render(wrapper, dest);
                src.x = -bounds.left * this.tileWidth + extrusion;
                src.y = -bounds.top * this.tileHeight + extrusion * 2;
                renderer.render(wrapper, dest);
                wrapper.mask = null;
                src.x = -bounds.left * this.tileWidth + extrusion;
                src.y = -bounds.top * this.tileHeight + extrusion;
                renderer.render(wrapper, dest);
                dest.requiresUpdate = true;
            },
            
            updateGrid: function () {
                var cache = this.cache,
                    cth = this.cacheTilesHeight,
                    ctw = this.cacheTilesWidth,
                    tsh = this.tilesHeight - 1,
                    tsw = this.tilesWidth - 1,
                    x = 0,
                    y = 0,
                    grid = this.cacheGrid;

                for (x = 0; x < grid.length; x++) {
                    for (y = 0; y < grid[x].length; y++) {
                        cache.setBounds(x * ctw, y * cth, Math.min((x + 1) * ctw, tsw), Math.min((y + 1) * cth, tsh));
                        this.update(grid[x][y].texture, cache);
                    }
                }
            },

            toJSON: function () { // This component is added by another component, so it shouldn't be returned for reconstruction.
                var imageMap = this.imageMap[0],
                    imgMap = [],
                    x = imageMap.length,
                    y = 0;
                
                while (x--) {
                    y = imageMap[x].length;
                    imgMap[x] = [];
                    while (y--) {
                        imgMap[x][y] = imageMap[x][y].id;
                    }
                }

                return {
                    type: 'RenderTiles',
                    buffer: this.buffer,
                    cacheAll: this.cacheAll,
                    entityCache: this.entityCache,
                    imageMap: imgMap,
                    maximumBuffer: this.maximumBuffer,
                    scaleX: this.scaleX,
                    scaleY: this.scaleY,
                    spriteSheet: this.spriteSheet,
                    tileCache: this.tileCache,
                    tileHeight: this.tileHeight,
                    tileWidth: this.tileWidth,
                    top: this.top,
                    left: this.left
                };
            },

            destroy: function () {
                var x = 0,
                    y = 0,
                    key = '',
                    grid = this.cacheGrid,
                    map = this.doMap,
                    img = this.imageMap;
                    
                if (grid) {
                    for (x = 0; x < grid.length; x++) {
                        for (y = 0; y < grid[x].length; y++) {
                            grid[x][y].texture.destroy(true);
                            this.parentContainer.removeChild(grid[x][y]);
                        }
                    }
                    grid.recycle(2);
                    delete this.cacheGrid;
                } else if (this.tilesSprite) {
                    if (this.tilesSprite.texture.alternate) {
                        this.tilesSprite.texture.alternate.destroy(true);
                    }
                    this.tilesSprite.texture.destroy(true);
                    this.parentContainer.removeChild(this.tilesSprite);
                } else {
                    this.parentContainer.removeChild(this.mapContainer);
                }
                
                img.recycle(2);
                
                for (key in this.tiles) {
                    if (this.tiles.hasOwnProperty(key)) {
                        this.tiles[key].destroy();
                    }
                }
                this.tiles = null;
                this.parentContainer = null;
                this.tilesSprite = null;
                this.spriteSheet.recycleSpriteSheet();
                
                if (map) {
                    for (x = 0; x < this.cachedDisplayObjects.length; x++) {
                        this.cachedDisplayObjects[x].destroy();
                    }
                    this.cachedDisplayObjects.recycle();

                    for (x = 0; x < map.length; x++) {
                        if (map[x]) {
                            for (y = 0; y < map.length; y++) {
                                if (map[x][y]) {
                                    map[x][y].recycle();
                                }
                            }
                            map[x].recycle();
                        }
                    }
                    map.recycle();
                }
                
                this.laxCam.recycle();
                this.cache.recycle();
                this.cachePixels.recycle();
            }
        },
        
        getAssetList: (function () {
            var
                getImages = function (ss, spriteSheets) {
                    if (ss) {
                        if (typeof ss === 'string') {
                            return getImages(spriteSheets[ss], spriteSheets);
                        } else if (ss.images) {
                            return ss.images.greenSlice();
                        }
                    }

                    return Array.setUp();
                };
            
            return function (component, props, defaultProps) {
                var arr = null,
                    i = 0,
                    images = null,
                    spriteSheets = platypus.game.settings.spriteSheets,
                    ss = component.spriteSheet || props.spriteSheet || defaultProps.spriteSheet;
                
                if (ss) {
                    if (typeof ss === 'string' && (ss !== 'import')) {
                        return getImages(ss, spriteSheets);
                    } else if (Array.isArray(ss)) {
                        i = ss.length;
                        images = Array.setUp();
                        while (i--) {
                            arr = getImages(ss[i], spriteSheets);
                            images.union(arr);
                            arr.recycle();
                        }
                        return images;
                    } else if (ss.images) {
                        return ss.images.greenSlice();
                    }
                }
                
                return Array.setUp();
            };
        }())
    });
}());
