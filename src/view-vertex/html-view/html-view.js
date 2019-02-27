import { stream, combine } from "air-stream"
import {equal, routeNormalizer, routeToString, signature} from "../../utils"
import events from "../events"
import JSON5 from "json5"
import { LiveSchema } from "../../live-schema"
import resource from "../../loader/resource"
import { NODE_TYPES } from "./def"
import Layer from "./layer"
import PlaceHolderContainer from "./place-holder-container"

const CUT_FRAMES_REG = /\[\s*["'](.+?)["']\s*,((?:\s*{.+?}\s*,\s*)?\s*(?:\[.+?]))\s*]/gs;
let UNIQUE_VIEW_KEY = 0;

export default class HTMLView extends LiveSchema {
	
	constructor( args, src, { createEntity = null } = {} ) {
		super( args, src );
		createEntity && (this.createEntity = createEntity);
		this.prop.use.schtype = this.prop.use.schtype || "html";
		this.prop.stream = this.prop.stream || "";
		this.prop.handlers = this.prop.handlers || [];
		this.prop.tee = this.prop.tee || [];
		this.prop.keyframes = this.prop.keyframes || [];
		this.prop.node = this.prop.node || document.createDocumentFragment();
	}

	createEntity( { $: { modelschema, layers: layers = new Map( [ [ -1, modelschema ] ] ) }, ...args } ) {
		return stream( (emt, { sweep, over }) => {
			let state = { stage: 0, target: null, active: false };
			const clayers = new Map(this.layers.map(
				({ acid: _acid, src: { acid }, prop: { stream } }, i, arr) => {
					if(stream[0] === "^") {
						const eLayer =
							arr.slice(0, i).find( ({ prop: { stream } }) => stream[0] !== "^" );
						if(!eLayer) {
							throw `the first view layer cannot refer to the predecessor stream`
						}
						const { src: { acid }, prop: { stream: pstream } } = eLayer;
						return [_acid, layers.get(acid).get( pstream + stream.substr(1) )];
					}
					else {
						return [_acid, layers.get(acid).get(stream)];
					}
				}
			));
			sweep.add( combine(
				[...clayers].map( ([, layer ]) => layer ),
				(...layers) => new Map([ ...clayers].map( ([ acid ], i) => [acid, layers[i]] ))
			).at( ( layers ) => {
				if(this.prop.tee.length || !this.prop.preload) {
					over.add(this.createTeeEntity( { $: { layers }, ...args } ).on(emt));
				}
				else {
					over.add(this.createNextLayers( { $: { layers }, ...args } ).on(emt));
				}
			} ) );
		} );
	}

	createLayer(owner, { targets, resources } ) {
		return new Layer( this, owner, { targets, resources } );
	}

	createNextLayers( { $: { layers }, ...args } ) {
		return stream( (emt, { sweep }) => {

			const container = new PlaceHolderContainer(this, { type: "layers" });

			let actives = [];
			let state = { stage: 0, key: this.key, target: container.target };
			
			sweep.add( () => actives.map( x => x.clear() ) );

			sweep.add( combine( [
				...this.layers.map( (layer) =>
					layer.createNodeEntity( { $: { container, layers }, ...args } )
				),
				this.createChildrenEntity( { $: { container, layers }, ...args } ),
			] ).at( (comps) => {

				const children = comps.pop();
				
				const { target } = container;
				container.append(...comps.map( ({ container: { target } }) => target));
				
				const slots = target.querySelectorAll(`slot[key]`);
				if(slots.length) {
					const _slots = [...slots].reduce(( cache, slot ) => {
						const key = slot.getAttribute("key");
						const exist = cache.get(key);
						if(!exist) {
							cache.set(key, slot);
						}
						else if(exist.parentNode === target && slot.parentNode !== target) {
							exist.remove();
							cache.set(key, slot);
						}
						else {
							slot.remove();
						}
						return cache;
					}, new Map());
					children.map( ([{target, key}]) => {
						_slots.get(JSON.stringify(key)).replaceWith( target );
					} );
				}
				else {
					container.append( ...children.map( ( [{ target }] ) => target ) );
				}
				sweep.add(combine(this.layers.map( ( layer, i ) => {
					return layer.createLayer(
						{ schema: { model: layers.get(layer.acid) } },
						{ resources: comps[i].resources,
							targets: [
								...comps[i].container.targets( "datas" ),
								...container.targets("actives")
							],
						}
					).stream;
				} )).at( (layers) => {
					if(state.stage === 0 && layers.every( ([ { stage } ]) => stage === 1)) {
						state = { ...state, stage: 1 };
						emt( [ state ] );
					}
				} ));
			}) );
		} );
	}

	createNodeEntity( ) {
		return stream( (emt, { sweep }) => {
			sweep.add(combine( this.prop.resources ).at( ( resources ) => {
				const container = new PlaceHolderContainer( this, { type: "node" } );
				container.append(this.prop.node.cloneNode(true));
				const imgs = resources.filter(({type}) => type === "img");
				[...container.target.querySelectorAll(`slot[img]`)]
					.map((target, i) => target.replaceWith(imgs[i].image));
				emt( { resources, container } );
			}));
		});
	}

	createTeeEntity( { $: { layers }, ...args } ) {

		//выбрать те слои с данными, в которых присутсвует tee
		const modelschema = combine(
			[...layers].map( ([,layer]) => layer.obtain() ),
			(...layers) => [Object.assign({}, ...layers.map(([state]) => state) )]
		);

		return stream( (emt, { sweep, hook }) => {

			let state = { key: this.key, stage: 0, active: false, target: null };
			let reqState = { stage: 1 };
			let loaderTarget = null;
			let loaderHook = null;
			let childHook = null;

			const container = new PlaceHolderContainer( this, { type: "entity" } );
			state.target = container.target;

			if(!this.prop.preload) {
				sweep.add( loaderHook = this.obtain( "#loader" )
					.at( ([ { stage, target } ]) => {
						if(state.stage === 0 && stage > 0) {
							loaderTarget = target;
							state = { ...state, stage: 1, };
							container.append( target );
							emt( [ state ] );
						}
					} )
				);
			}
			const view = this.createNextLayers( { $: { layers }, ...args } );
			sweep.add( modelschema.at( ([ data ]) => {
				const active = this.prop.tee.every(tee => signature(tee, data));
				if(active !== state.active) {
					state = { ...state, active };
					if(active) {
						sweep.add( childHook = view
							.at( ([ { target } ]) => {
								container.begin.after( target );
							} )
						);
					}
					else {
						clearContainer( container );
						childHook && sweep.force( childHook );
						childHook = null;
					}
				}
			} ) );
			sweep.add( combine([ modelschema.ready(), view ]).at( ([ data ]) => {
				if(reqState && reqState.stage === 1) {
					if(!this.prop.preload) {
						sweep.force(loaderHook);
						loaderTarget && loaderTarget.remove();
					}
					reqState = null;
					state = { ...state, stage: 1,  };
					emt( [ state ] );
				}
			} ) );
		});
	}

	createChildrenEntity( { $: { container: { target, begin }, layers }, ...args } ) {
		return combine(
			this.item
				.filter( ({ prop: { template } }) => !template )
				.map(x => x.obtain( "", { $: { layers } } ))
		);
	}
	
	createSystemBoundNode( point, species ) {
		const label = typeof this.prop.key === "object" ?
			JSON.stringify(this.prop.key) : this.prop.key;
		return document.createComment(
			`${point} ${species} ${this.acid} ${label} ${point}`.toUpperCase()
		);
	}
	
	parse(node, src, { pack } ) {
		return this.constructor.parse( node, src, { pack } );
	}
	
	static parse( node, src, { pack, type = "unit" } ) {
		
		if(!(node instanceof Element)) {
			return new HTMLView( ["", {}], src, { createEntity: node } );
		}
		
		const { path = "./", key: pkey = ++UNIQUE_VIEW_KEY+"" } = (src || {}).prop || {};
		
		let key = node.getAttribute("key");
		
		if(key !== null) {
			if(/[`"'{}\]\[]/.test(key)) {
				key = JSON5.parse(key);
			}
		}
		else {
			key = pkey;
		}
		
		const handlers = [ ...node.attributes ]
			.filter( ({ name }) => events.includes(name) )
			.map( ({ name, value }) => ({
				name: name.replace(/^on/, ""),
				hn: new Function("event", "options", "request", "key", value )
			}) );
		
		let stream = node.getAttribute("stream");
		stream = stream && routeNormalizer(stream.toString()) || { route: [] };
		stream.route = stream.route.map( seg => seg === "$key" ? key : seg );
		Object.keys( stream ).map( prop => stream[prop] === "$key" && (stream[prop] = key) );
		stream = routeToString(stream);
		
		const template = ["", "true"].includes(node.getAttribute("template"));
		const id = node.getAttribute("id") || "$";
		let use = (node.getAttribute("use") || "").trim();
		let [ , source = null ] = use && use.match( /^url\((.*)\)$/ ) || [];

		use = source && { path: source, schtype: type === "custom" ? "js" : "html" } || { };

        const resources =
            [ ...(src.acid > -1 && src.prop.resources || []), ...JSON5
                .parse(node.getAttribute("resources") || "[]")
                .map( x => resource(pack, x) )
            ];
		
        const tee = cuttee(node, key);
        const preload = !["false"].includes(node.getAttribute("preload"));

		const keyframes = parseKeyFrames( { node } );

		const prop = {
            tee,            //switch mode
            preload,        //must be fully loaded before readiness
            pack,           //current package
			keyframes,      //animation ( data ) settings
			use,            //reused templates path
			template,       //template node
			id,             //tree m2 advantages id
			type,           //view node type [node -> unit, switcher -> tee]
			source,         //m2 advantages source path if module
			handlers,       //event handlers
			path,           //absolute path
			node,           //xml target node
			key,            //inherited or inner key
			stream,         //link to model stream todo obsolete io
			resources,      //related resources
		};
		
		const res = src.acid > -1 && src.lift( [ key, prop ], src ) || new HTMLView( [ key, prop ], src );
		
		//[...node.childNodes].map( next => setup( next, res.prop ));
		
		res.append(...[...node.children].reduce((acc, next) =>
				[...acc, ...parseChildren( next, res.prop, res )]
			, []));
		
		res.prop.node = document.createDocumentFragment();
		res.prop.node.append( ...node.childNodes );

		return res;
		
	}
	
	mergeProperties( name, value ) {
		if(name === "stream") {
			return this.prop.stream;
		}
		else if( name == "tee" ) {
			return [ ...this.prop.tee, ...value];
		}
		else if(["handlers", "keyframes", "node", "template", "pack", "source"].includes(name)) {
			return this.prop[name];
		}
		else {
			return super.mergeProperties( name, value );
		}
	}
	
}

function parseKeyFrames( { node } ) {
	let res = [];
	const keyframe = node.querySelectorAll("keyframe");
	if(keyframe.length) {
		res = [...keyframe].map( node => {
			const action = node.getAttribute("name") || "default";
			let prop = (node.getAttribute("prop"));
			if(prop) {
				prop = prop.replace(/\([a-b0-9]+?\)/g, (_, reg) => {
					return `(argv${reg})`;
				});
				prop = new Function("argv", "ttm", `{return ${prop}}`);
			}
			const keys = [...node.querySelectorAll("key")]
				.map( node => {
					let offset = node.getAttribute("offset");
					let prop = node.getAttribute("prop");
					if(prop) {
						prop = prop.replace(/\([a-b0-9]+?\)/g, (_, reg) => {
							return `(argv${reg})`;
						});
						prop = new Function("argv", "ttm", `{return ${prop}}`);
					}
					return [ offset, prop ];
				} )
			node.remove();
			return [ action, prop, ...keys ];
		} );
	}
	return res;
}

function cuttee(node, key) {
	const rawTee = node.getAttribute("tee");
	if(rawTee === null) {
		return [];
	}
	else if(rawTee === "") {
		return [ key ];
	}
	else if(rawTee[0] === "{") {
		return [ JSON5.parse(rawTee) ];
	}
	else {
		return [ rawTee ];
	}
}
/*
function setup( next, { keyframes } ) {
	if(next.nodeType === 3 && !is( next.parentNode, "setup" )) {
		const templates = next.nodeValue.match(/{(?:intl|lang|argv).+?}/g);
		templates && next.replaceWith( ...templates.map(
			text => {
				const res = document.createElement("setup");
				res.textContent = text;
				return res;
			}
		));
	}
	if(is( next, "setup" )) {
		if(!is( next.parentNode.parentNode, "unit" ) ) {
			const replaced = next.parentNode;
			const unit = document.createElement("unit");
			replaced.replaceWith( unit );
			unit.append( replaced );
		}
		else {
			
			if(next.textContent) {
				if(!keyframes.find(([name]) => name === "*")) {
					keyframes.push( [ "*", [ 100 ] ] );
				}
			}
			
			let keyframesAttribute = next.getAttribute("keyframes");
			if(keyframesAttribute) {
				
				if(keyframesAttribute.indexOf("[") < 0) {
					keyframesAttribute = `[[ "*", {}, [100, ${keyframesAttribute}]]]`
				}
				
				keyframesAttribute.replace(CUT_FRAMES_REG, (all, action, fn) => {
					let exist = keyframes.findIndex(([x]) => x === action);
					if(exist < 0) {
						exist = keyframes.length;
					}
					const handler = new Function("argv", `return ["${action}", ${fn}]`);
					keyframes[exist] = [ action, ({argv} = {}) => handler(argv) ];
				});
				
			}
			
		}
	}
	return [...next.childNodes].map( node =>
		!is( node, "unit" ) && setup(node, { keyframes })
	);
}*/

function slot( { key } ) {
	const res = document.createElement("slot");
	res.setAttribute("key", JSON.stringify(key));
	return res;
}

function img() {
	const res = document.createElement("slot");
	res.setAttribute("img", "");
	return res;
}

/**
 *
 * @param node
 * @param {String} name
 * @returns {boolean}
 */
function is( node, name ) {
	name = name.toUpperCase();
	return [ `M2-${name}`, name ].includes( node.tagName );
}

//the workaround is tied to the querySelectorAll,
// since it is used to extract replacement slots
function parseChildren(next, { resources, path, key }, src) {
	if(is( next, "unit" )) {
		const parser = HTMLView.parse(next, src, { pack: src.prop.pack });
		const _slot = slot( parser );
		parser.prop.template ? next.remove() : next.replaceWith( _slot );
		return [ parser ];
	}
	else if(is( next, "plug" )) {
		const parser = HTMLView.parse(next, src, {
			key, path, type: "custom", pack: src.prop.pack
		});
		const _slot = slot( parser );
		parser.prop.template ? next.remove() : next.replaceWith( _slot );
		return [ parser ];
	}
	else if (next.tagName === "IMG") {
		const _slot = img( );
		next.replaceWith( _slot );
		resources.push(
			resource(src.prop.pack, { type: "img", url: next.getAttribute("src") })
		);
		return [];
	}
	else if(next.tagName === "STYLE") { }
	return [...next.children].reduce( (acc, node) =>
			[...acc, ...parseChildren(node, { resources, path, key }, src)]
		, []);
}

function clearContainer({ begin, end }) {
	while (begin.nextSibling !== end) {
		begin.nextSibling.remove();
	}
}