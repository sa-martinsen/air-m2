import {Observable} from "air-stream"
import include from "./script_like_promise"

export default class Loader {

    constructor({path = "m2units/"} = {}) {
        this.rpath = path;
        this.modules = [];
        window.m2unit = {};
    }

    obtain(advantages) {
        const {source: {path: _path}} = advantages;
        let path = _path.indexOf(".json") > 0 ? _path.replace(".json", "") + "/index.json" : _path;
        path = _path.indexOf(".html") > 0 ? _path.replace(".html", "") + "/index.html" : _path;
        const exist = this.modules.find( ({ path: _path }) => path === _path );
        if(exist) {
            return exist.module;
        }
        else {
            const module = new Observable( emt => {
                /*todo es6 dynamic
                eval(`import("./${this.rpath}${path}")`).then(module => {
                    emt({data: module});
                } );
                */
                include({path: `${this.rpath}${path}`}).then(({module}) => {
                    emt({module: module || window.m2unit, advantages});
                } );
            } );
            this.modules.push({module, path});
            return module;
        }
    }

    //static default = new Loader();

}

Loader.default = new Loader();