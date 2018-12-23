import { routeNormalizer } from "../../utils"
import events from "../events"

let UQID = 0;

const targeting = ( node ) =>
    [...node.children].reduce( (acc, next) => {
        if(Parser.is( next, "setup" )) {
            const keyframes = JSON5.parse(next.getAttribute("keyframes") || "[]");
            let props = next.getAttribute("props");
            if(props) {
                const cdc = new Function( "key", "argv", `{return ${props}}` );
                props = argv => cdc(key, argv);
            }
            next.remove();
            return [ ...acc, {
                node: next,
                keyframes,
                props
            } ];
        }
        return acc;
    }, []);

export default class Parser {

    static slot() {
        return document.createElement("M2-SLOT");
    }

    /**
     *
     * @param node
     * @param {String} name
     * @returns {boolean}
     */
    static is( node, name ) {
        name = name.toUpperCase();
        return [ `M2-${name}`, name ].includes( node.tagName );
    }

    /**
     *
     * @param {Element} node
     * @param uqid
     * @param path
     * @param key
     */
    static parse( node, {
        uqid, path = "", key: pkey = null, outerProps = {}
    } = {} ) {

        const acid = ++UQID;
        uqid = uqid || acid;

        const slots = [];

        let key = node.getAttribute("key");

        if(key) {
            if(/[`"'{}\]\[]/.test(key)) {
                key = JSON5.parse(key);
            }
        }
        else {
            key = pkey;
        }

        const handlers = [ ...node.attributes ]
            .filter( attr => events.includes(attr) )
            .map( ({ name, value }) => ({
                name: name.replace(/^on/, ""),
                hn: new Function("event", "options", "action", "key", value )
            }) );
        
        const resources = JSON5.parse(node.getAttribute("resources") || "[]");

        let dir = node.getAttribute("dir");
        dir = dir && routeNormalizer(dir.toString()) || { route: "" };
        Object.keys( dir ).map( prop => dir[prop] === "$key" && (dir[prop] = key) );

        const props = {
            //event handlers
            handlers,
            //absolute path
            path,
            //settings to props changers ( function )
            targeting,
            //slotted sign
            uqid,
            //injection slots
            slots,
            //system unique id
            acid,
            //xml target node
            node,
            //inherited or inner key
            key,
            //model stream directory path
            dir,
            //outer props ( if injected as 'use' )
            ...outerProps,
            //related resources
            resources
        };

        return [
            //sign
            // key - when it is not inherited from the parent
            // else - unique id
            key !== pkey ? key : acid,
            props,
            ...[...node.children].reduce((acc, next) => {
                const use = (next.getAttribute("use") || "").toString();
                const uqid = use && (path + use) || undefined;
                if(Parser.is( next, "unit" )) {
                    const slot = Parser.slot();
                    next.replaceWith( slot );
                    if(use) {
                        slots.push( { slot, uqid } );
                        return [ ...acc, Parser.parse(next, { key, path, uqid }) ];
                    }
                    else {
                        slots.push( { slot, uqid } );
                        return [ ...acc, Parser.parse(next, { key, path, uqid }) ];
                    }
                }
                else if (next.tagName === "IMG") {
                    const slot = Parser.slot();
                    next.replaceWith( slot );
                    resources.push( { uqid, type: "image", url: next.getAttribute("src") } );
                    return acc;
                }
                return acc;
            }, []),
        ];

    }

}