import Promise from 'bluebird'
import path from 'path'
import Yazl from 'yazl'
import fs from 'fs-extra'
import { typeOf } from 'lutils'
import Yaml from 'js-yaml'

import ModuleBundler from './ModuleBundler'
import SourceBundler from './SourceBundler'
import FileBuild from './FileBuild'

Promise.promisifyAll(fs)

// FIXME: for debugging, remove later
console.inspect = (val, ...args) => console.log( require('util').inspect(val, { depth: 6, colors: true, ...args }) )

export default class ServerlessBuildPlugin {
    config = {
        tryFiles    : [ "webpack.config.js" ],
        baseExclude : [ /\bnode_modules\b/ ],

        modules: {
            exclude     : [ 'aws-sdk' ], // These match root dependencies
            deepExclude : [ 'aws-sdk' ], // These match deep dependencies
        },

        exclude : [],
        include : [],

        uglify        : true,
        uglifySource  : false,
        uglifyModules : true,

        babel      : null,
        sourceMaps : true,

        // Passed to `yazl` as options
        zip: { compress: true },

        method : 'bundle',
        file   : null,

        functions: {}
    }

    constructor(serverless, options = {}) {
        //
        // SERVERLESS
        //

        this.serverless = serverless

        if ( ! this.serverless.getVersion().startsWith('1') )
            throw new this.serverless.classes.Error(
                'serverless-build-plugin requires serverless@1.x.x'
            )

        this.hooks = {
          //  'deploy'                                  : (...args) => console.log('wew'), // doesn't fire
            'before:invoke:local:invoke'              :(...args)=>{console.log('Executing before:invoke:local:invoke'); return this.build(true)},
            'before:deploy:createDeploymentArtifacts' : (...args) => {console.log('Executing before:deploy:createDeploymentArtifacts');return this.build(false)}, // doesn't fire
           // 'deploy:createDeploymentArtifacts'        : (...args) => this.build(...args), // doesn't fire
            'before:deploy:function:deploy'           : (...args) => {console.log('Executing before:deploy:function:deploy'); return this.build(false)},
        }

        //
        // PLUGIN CONFIG GENERATION
        //

        this.servicePath    = this.serverless.config.servicePath
        this.tmpDir         = path.join(this.servicePath, './.serverless')
        this.buildTmpDir    = path.join(this.tmpDir, './build')
        this.artifactTmpDir = path.join(this.tmpDir, './artifacts')

        const buildConfigPath = path.join(this.servicePath, './serverless.build.yml')

        const buildConfig = fs.existsSync(buildConfigPath)
            ? Yaml.load( fs.readFileSync(buildConfigPath) )
            : {}

        // The config inherits from multiple sources
        this.config = {
            ...this.config,
            ...( (this.serverless.service.custom?this.serverless.service.custom.build || {}:{}) ),
            ...buildConfig,
            ...options,
        }

        const { functions } = this.serverless.service

        let selectedFunctions = typeOf.Array(this.config.function)
            ? this.config.function
            : [ this.config.function ]

        selectedFunctions = selectedFunctions.filter((key) => key in functions )
        selectedFunctions = selectedFunctions.length ? selectedFunctions : Object.keys(functions)

        /**
         *  An array of full realized functions configs to build against.
         *  Inherits from
         *  - serverless.yml functions.<fn>.package
         *  - serverless.build.yml functions.<fn>
         *
         *  in order to generate `include`, `exclude`
         */
        this.functions = selectedFunctions.reduce((obj, fnKey) => {
            const fnCfg      = functions[fnKey]
            const fnBuildCfg = this.config.functions[fnKey] || {}

            const include = [
                ...( this.config.include || [] ),
                ...( ( fnCfg.package && fnCfg.package.include ) || [] ),
                ...( fnBuildCfg.include || [] )
            ]

            const exclude = [
                ...( this.config.baseExclude || [] ),
                ...( this.config.exclude || [] ),
                ...( ( fnCfg.package && fnCfg.package.exclude ) || [] ),
                ...( fnBuildCfg.exclude || [] )
            ]

            // Utilize the proposed `package` configuration for functions
            obj[fnKey] = {
                ...fnCfg,

                package: {
                    ...( fnCfg.package || {} ),
                    ...( this.config.functions[fnKey] || {} ),
                    include, exclude
                }
            }

            return obj
        }, {})

        this.serverless.cli.log(`Serverless Build config:`)
        console.inspect(this.config)
    }

    /**
     *  Builds either from file or through the babel optimizer.
     */
    async build(isLocalExecution) {
        // TODO in the future:
        // - create seperate zips
        // - modify artifact completion process, splitting builds up into seperate artifacts

        this.serverless.cli.log("Serverless Build triggered...")


        const { method }   = this.config
        let moduleIncludes = []

        await fs.ensureDirAsync(this.buildTmpDir)
        await fs.ensureDirAsync(this.artifactTmpDir)

        const artifact = new Yazl.ZipFile()

        if ( method === 'bundle' ) {
            //
            // SOURCE BUNDLER
            //

            const sourceBundler = new SourceBundler({
                ...this.config,
                uglify      : this.config.uglifySource ? this.config.uglify : undefined,
                servicePath : this.servicePath,
                isLocalExecution: isLocalExecution,
                buildTmpDir: this.buildTmpDir
            }, artifact)

            for ( const fnKey in this.functions ) {
                const config = this.functions[fnKey]

                this.serverless.cli.log(`Bundling ${fnKey}...`)

                // Synchronous for now, but can be parellel
                await sourceBundler.bundle({
                    exclude : config.package.exclude,
                    include : config.package.include,
                })
            }
        } else
        if ( method === 'file' ) {
            //
            // BUILD FILE
            //

            // This builds all functions
            const fileBuild = await new FileBuild({
                ...this.config,
                servicePath : this.servicePath,
                buildTmpDir : this.buildTmpDir,
                functions   : this.functions,
                serverless  : this.serverless,
                isLocalExecution: isLocalExecution,
                buildTmpDir: this.buildTmpDir
            }, artifact).build()

            moduleIncludes = [ ...fileBuild.externals ] // Spread, for an iterator
        } else {
            throw new Error("Unknown build method under `custom.build.method`")
        }

        await new ModuleBundler({
            ...this.config,
            uglify      : this.config.uglifyModules ? this.config.uglify : undefined,
            servicePath : this.servicePath,
            isLocalExecution: isLocalExecution,
            buildTmpDir: this.buildTmpDir
        }, artifact).bundle({
            include: moduleIncludes,
            ...this.config.modules
        })

        await this._completeArtifact(artifact,isLocalExecution)

        if ( this.config.test )
            throw new Error("--test mode, DEBUGGING STOP")
    }

    /**
     *  Writes the `artifact` and attaches it to serverless
     */
    async _completeArtifact(artifact, isLocalExecution) {
        // Purge existing artifacts

        if(isLocalExecution){
            this.serverless.config.servicePath = this.buildTmpDir;
            console.log(this.serverless.config.servicePath);
        }else{
            if ( ! this.config.keep )
                await fs.emptyDirAsync(this.artifactTmpDir)

            const zipPath = path.resolve(this.artifactTmpDir, `./${this.serverless.service.service}-${new Date().getTime()}.zip`)

            await new Promise((resolve, reject) => {
                artifact.outputStream.pipe( fs.createWriteStream(zipPath) )
                    .on("error", reject)
                    .on("close", resolve)

                artifact.end()
            })

            this.serverless.service.package.artifact = zipPath

            //Purge build dir
            if ( ! this.config.keep )
                await fs.emptyDirAsync(this.buildTmpDir)
        }


    }
}
