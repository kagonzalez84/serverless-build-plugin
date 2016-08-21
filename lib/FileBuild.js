import Promise from 'bluebird'
import path from 'path'
import { typeOf } from 'lutils'
import fs from 'fs-extra'
import WebpackBuilder from './Webpack'
import isStream from 'is-stream'


Promise.promisifyAll(fs)

export default class FileBuild {
    constructor(plugin, artifact) {
        this.plugin    = plugin
        this.artifact  = artifact
        this.externals = new Set()
    }

    /**
     *  Handles building from a build file's output.
     */
    async build() {
        const { config: { servicePath } } = this.plugin.serverless

        //
        // RESOLVE BUILD FILE
        //

        let builderFilePath = await this._tryBuildFiles()

        if ( ! builderFilePath )
            throw new Error("Unrecognized build file path")

        builderFilePath = path.resolve(servicePath, builderFilePath)

        let result = require(builderFilePath)

        // Resolve any functions...
        if ( typeOf.Function(result) )
            result = await Promise.try(() => result(this))

        // Ensure directories
        await fs.mkdirsAsync(this.plugin.buildTmpDir)
        await fs.mkdirsAsync(this.plugin.artifactTmpDir)

        //
        // HANDLE RESULT OUTPUT:
        //
        // - String, Buffer or Stream:   piped as 'handler.js' into zip
        // - Webpack Config:             executed and output files are zipped
        //

        if ( typeOf.Object(result) ) {
            //
            // WEBPACK CONFIG
            //

            const { externals } = await new WebpackBuilder(this.plugin).build(result)

            for ( let ext of externals )
                this.externals.add(ext)

            ;[ 'handler.js', `handler.js.map`].forEach(async (fileName) => {
                const filePath = path.resolve(this.plugin.buildTmpDir, fileName)

                const stats = await fs.statAsync(filePath)

                // Ensure file exists first
                if ( stats.isFile() )
                    this.artifact.addFile(filePath, fileName, this.plugin.config.zip)
            })
        } else
        if ( typeOf.String(result) || result instanceof Buffer ) {
            //
            // STRINGS, BUFFERS
            //

            if ( typeOf.String(result) ) result = new Buffer(result)

            this.artifact.addBuffer(result, 'handler.js', this.plugin.config.zip)

        } else
        if ( isStream(result) ) {
            //
            // STREAMS
            //

            this.artifact.addReadStream(result, 'handler.js', this.plugin.config.zip)

        } else {
            throw new Error("Unrecognized build output")
        }

        // TODO: read from serverless.yml -> package.includes for extenerals as well as excludes

        return this
    }


    /**
     *  Allows for build files to be auto selected
     */
    async _tryBuildFiles() {
        for ( let fileName of this.plugin.config.tryFiles ) {
            const exists = await fs.statAsync(fileName).then((stat) => stat.isFile())

            if ( exists ) return fileName
        }

        return null
    }
}