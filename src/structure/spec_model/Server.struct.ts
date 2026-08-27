import { mkdirs, pathExists } from 'fs-extra/esm'
import { lstat, readdir, readFile, writeFile } from 'fs/promises'
import { Server, Module } from 'helios-distribution-types'
import { dirname, join, resolve as resolvePath } from 'path'
import { URL } from 'url'
import { VersionSegmentedRegistry } from '../../util/VersionSegmentedRegistry.js'
import { ServerMeta, getDefaultServerMeta, ServerMetaOptions, UntrackedFilesOption } from '../../model/nebula/ServerMeta.js'
import { BaseModelStructure } from './BaseModel.struct.js'
import { FabricModStructure } from './module/FabricMod.struct.js'
import { MiscFileStructure } from './module/File.struct.js'
import { LibraryStructure } from './module/Library.struct.js'
import { MinecraftVersion } from '../../util/MinecraftVersion.js'
import { addSchemaToObject, SchemaTypes } from '../../util/SchemaUtil.js'
import { isValidUrl } from '../../util/StringUtils.js'
import { FabricResolver } from '../../resolver/fabric/Fabric.resolver.js'
import { NeoForgeResolver } from '../../resolver/neoforge/NeoForge.resolver.js'
import { NeoForgeModStructure } from './module/NeoForgeMod.struct.js'

export interface CreateServerResult {
    modContainer?: string
    libraryContainer: string
    miscFileContainer: string
}

export class ServerStructure extends BaseModelStructure<Server> {

    private readonly ID_REGEX = /^(.+)-(\d+\.\d+(?:\.\d+)?)$/
    private readonly MINECRAFT_VERSION_NAME_REGEX = /minecraft\s+(\d+\.\d+(?:\.\d+)?)/i
    private readonly SERVER_META_FILE = 'servermeta.json'

    constructor(
        absoluteRoot: string,
        baseUrl: string,
        private discardOutput: boolean,
        private invalidateCache: boolean
    ) {
        super(absoluteRoot, '', 'servers', baseUrl)
    }

    public getLoggerName(): string {
        return 'ServerStructure'
    }

    public async getSpecModel(): Promise<Server[]> {
        if (this.resolvedModels == null) {
            this.resolvedModels = await this._doSeverRetrieval()
        }
        return this.resolvedModels
    }

    public static getEffectiveId(id: string, minecraftVersion: MinecraftVersion): string {
        return `${id}-${minecraftVersion}`
    }

    public async createServer(
        id: string,
        minecraftVersion: MinecraftVersion,
        options: {
            version?: string
            forgeVersion?: string
            fabricVersion?: string
            neoforgeVersion?: string
        }
    ): Promise<CreateServerResult | null> {
        const effectiveId = ServerStructure.getEffectiveId(id, minecraftVersion)
        const absoluteServerRoot = resolvePath(this.containerDirectory, effectiveId)
        const relativeServerRoot = join(this.relativeRoot, effectiveId)

        if (await pathExists(absoluteServerRoot)) {
            this.logger.error('Server already exists! Aborting.')
            return null
        }

        await mkdirs(absoluteServerRoot)

        const serverMetaOpts: ServerMetaOptions = {
            version: options.version
        }
        let modContainer: string | undefined = undefined

        if (options.forgeVersion != null) {
            const fms = VersionSegmentedRegistry.getForgeModStruct(
                minecraftVersion,
                options.forgeVersion,
                absoluteServerRoot,
                relativeServerRoot,
                this.baseUrl,
                []
            )
            await fms.init()
            modContainer = fms.getContainerDirectory()
            serverMetaOpts.forgeVersion = options.forgeVersion
        }

        if (options.fabricVersion != null) {
            const fms = new FabricModStructure(
                absoluteServerRoot,
                relativeServerRoot,
                this.baseUrl,
                minecraftVersion,
                []
            )
            await fms.init()
            modContainer = fms.getContainerDirectory()
            serverMetaOpts.fabricVersion = options.fabricVersion
        }

        if (options.neoforgeVersion != null) {
            const nms = new NeoForgeModStructure(
                absoluteServerRoot,
                relativeServerRoot,
                this.baseUrl,
                minecraftVersion,
                []
            )
            await nms.init()
            modContainer = nms.getContainerDirectory()
            serverMetaOpts.neoforgeVersion = options.neoforgeVersion
        }

        const serverMeta: ServerMeta = addSchemaToObject(
            getDefaultServerMeta(id, minecraftVersion.toString(), serverMetaOpts),
            SchemaTypes.ServerMetaSchema,
            this.absoluteRoot
        )
        await writeFile(resolvePath(absoluteServerRoot, this.SERVER_META_FILE), JSON.stringify(serverMeta, null, 2))

        const libS = new LibraryStructure(absoluteServerRoot, relativeServerRoot, this.baseUrl, minecraftVersion, [])
        await libS.init()

        const mfs = new MiscFileStructure(absoluteServerRoot, relativeServerRoot, this.baseUrl, minecraftVersion, [])
        await mfs.init()

        return {
            modContainer,
            libraryContainer: libS.getContainerDirectory(),
            miscFileContainer: mfs.getContainerDirectory()
        }

    }

    private async _doSeverRetrieval(): Promise<Server[]> {

        const accumulator: Server[] = []
        const files = await readdir(this.containerDirectory)
        for (const file of files) {
            const absoluteServerRoot = resolvePath(this.containerDirectory, file)
            const relativeServerRoot = join(this.relativeRoot, file)
            if ((await lstat(absoluteServerRoot)).isDirectory()) {

                this.logger.info(`Beginning processing of ${file}.`)

                // Read server meta
                const serverMeta = JSON.parse(await readFile(resolvePath(absoluteServerRoot, this.SERVER_META_FILE), 'utf-8')) as ServerMeta
                const resolvedIdentity = this.resolveServerIdentity(file, serverMeta)
                if (resolvedIdentity == null) {
                    this.logger.warn(`Skipping server directory ${file}, Minecraft version could not be resolved.`)
                    this.logger.warn('Use folder name format "<id>-<minecraft version>" or set servermeta.minecraftVersion.')
                    continue
                }
                const minecraftVersion = new MinecraftVersion(resolvedIdentity.minecraftVersion)
                const untrackedFiles: UntrackedFilesOption[] = serverMeta.untrackedFiles || []

                let iconUrl: string = null!

                // Resolve server icon

                if(serverMeta.meta.icon && isValidUrl(serverMeta.meta.icon)) {
                    // Use the url they gave us.
                    iconUrl = serverMeta.meta.icon
                } else {

                    this.logger.info('Server icon is either not set or not a valid URL.')
                    this.logger.info(`Looking for an icon file at ${absoluteServerRoot}`)

                    const subFiles = await readdir(absoluteServerRoot)
                    for (const subFile of subFiles) {
                        const caseInsensitive = subFile.toLowerCase()
                        if (caseInsensitive.endsWith('.jpg') || caseInsensitive.endsWith('.png')) {
                            iconUrl = new URL(join(relativeServerRoot, subFile), this.baseUrl).toString()
                        }
                    }

                    if (!iconUrl) {
                        this.logger.warn(`No icon file found for server ${file}.`)
                    }
                }

                const modules: Module[] = []

                if(serverMeta.forge) {
                    const forgeResolver = VersionSegmentedRegistry.getForgeResolver(
                        minecraftVersion,
                        serverMeta.forge.version,
                        dirname(this.containerDirectory),
                        '',
                        this.baseUrl,
                        this.discardOutput,
                        this.invalidateCache
                    )

                    // Resolve forge
                    const forgeItselfModule = await forgeResolver.getModule()
                    modules.push(forgeItselfModule)

                    const forgeModStruct = VersionSegmentedRegistry.getForgeModStruct(
                        minecraftVersion,
                        serverMeta.forge.version,
                        absoluteServerRoot,
                        relativeServerRoot,
                        this.baseUrl,
                        untrackedFiles
                    )

                    const forgeModModules = await forgeModStruct.getSpecModel()
                    modules.push(...forgeModModules)
                }

                if(serverMeta.fabric) {
                    const fabricResolver = new FabricResolver(dirname(this.containerDirectory), '', this.baseUrl, serverMeta.fabric.version, minecraftVersion)
                    if (!fabricResolver.isForVersion(minecraftVersion, serverMeta.fabric.version)) {
                        throw new Error(`Fabric resolver does not support Fabric ${serverMeta.fabric.version}!`)
                    }

                    const fabricModule = await fabricResolver.getModule()
                    modules.push(fabricModule)

                    const fabricModStruct = new FabricModStructure(
                        absoluteServerRoot,
                        relativeServerRoot,
                        this.baseUrl,
                        minecraftVersion,
                        untrackedFiles
                    )

                    const fabricModModules = await fabricModStruct.getSpecModel()
                    modules.push(...fabricModModules)
                }

                if(serverMeta.neoforge) {
                    const neoforgeResolver = new NeoForgeResolver(
                        dirname(this.containerDirectory),
                        '',
                        this.baseUrl,
                        serverMeta.neoforge.version,
                        minecraftVersion
                    )
                    const neoforgeModule = await neoforgeResolver.getModule()
                    modules.push(neoforgeModule)

                    const neoforgeModStruct = new NeoForgeModStructure(
                        absoluteServerRoot,
                        relativeServerRoot,
                        this.baseUrl,
                        minecraftVersion,
                        untrackedFiles
                    )
                    const neoforgeModModules = await neoforgeModStruct.getSpecModel()
                    modules.push(...neoforgeModModules)
                }

                const libraryStruct = new LibraryStructure(absoluteServerRoot, relativeServerRoot, this.baseUrl, minecraftVersion, untrackedFiles)
                const libraryModules = await libraryStruct.getSpecModel()
                modules.push(...libraryModules)

                const fileStruct = new MiscFileStructure(absoluteServerRoot, relativeServerRoot, this.baseUrl, minecraftVersion, untrackedFiles)
                const fileModules = await fileStruct.getSpecModel()
                modules.push(...fileModules)

                accumulator.push({
                    id: resolvedIdentity.id,
                    name: serverMeta.meta.name,
                    description: serverMeta.meta.description,
                    icon: iconUrl,
                    version: serverMeta.meta.version,
                    address: serverMeta.meta.address,
                    minecraftVersion: resolvedIdentity.minecraftVersion,
                    ...(serverMeta.meta.discord ? {discord: serverMeta.meta.discord} : {}),
                    mainServer: serverMeta.meta.mainServer,
                    autoconnect: serverMeta.meta.autoconnect,
                    javaOptions: serverMeta.meta.javaOptions,
                    modules
                })

            } else {
                this.logger.warn(`Path ${file} in server directory is not a directory!`)
            }
        }
        return accumulator
    }

    private resolveServerIdentity(
        folderName: string,
        serverMeta: ServerMeta
    ): { id: string, minecraftVersion: string } | null {
        const fromFolder = this.ID_REGEX.exec(folderName)
        if (fromFolder != null) {
            return {
                id: fromFolder[1],
                minecraftVersion: fromFolder[2]
            }
        }

        if (serverMeta.minecraftVersion != null && MinecraftVersion.isMinecraftVersion(serverMeta.minecraftVersion)) {
            this.logger.info(`Server directory ${folderName} does not end with -<minecraft version>, using servermeta.minecraftVersion.`)
            return {
                id: folderName,
                minecraftVersion: serverMeta.minecraftVersion
            }
        }

        const serverName = serverMeta.meta?.name
        if (serverName != null) {
            const fromName = this.MINECRAFT_VERSION_NAME_REGEX.exec(serverName)
            if (fromName != null && MinecraftVersion.isMinecraftVersion(fromName[1])) {
                this.logger.warn(`Server directory ${folderName} does not end with -<minecraft version>, inferred version from servermeta.meta.name.`)
                return {
                    id: folderName,
                    minecraftVersion: fromName[1]
                }
            }
        }

        return null
    }

}
