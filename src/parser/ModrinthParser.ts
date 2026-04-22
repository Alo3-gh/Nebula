import { createWriteStream } from 'fs'
import { mkdirs } from 'fs-extra/esm'
import got from 'got'
import StreamZip from 'node-stream-zip'
import { dirname, join, resolve } from 'path'
import { pipeline } from 'stream/promises'
import { ToggleableNamespace } from '../structure/spec_model/module/ToggleableModule.struct.js'
import { CreateServerResult } from '../structure/spec_model/Server.struct.js'
import { LoggerUtil } from '../util/LoggerUtil.js'

const log = LoggerUtil.getLogger('ModrinthParser')

type ModrinthEnvSupport = 'required' | 'optional' | 'unsupported'

export interface ModrinthManifest {
    game: string
    formatVersion: number
    versionId: string
    name: string
    summary?: string
    files: {
        path: string
        hashes: Record<string, string>
        downloads: string[]
        fileSize?: number
        env?: {
            client?: ModrinthEnvSupport
            server?: ModrinthEnvSupport
        }
    }[]
    dependencies: Record<string, string>
}

export class ModrinthParser {

    private modpackDir: string
    private packPath: string

    constructor(
        private absoluteRoot: string,
        private packFileName: string
    ) {
        this.modpackDir = join(absoluteRoot, 'modpacks', 'modrinth')
        this.packPath = join(this.modpackDir, packFileName)
    }

    public async init(): Promise<void> {
        await mkdirs(this.modpackDir)
    }

    public async getModpackManifest(): Promise<ModrinthManifest> {
        const zip = new StreamZip.async({ file: this.packPath })
        try {
            return JSON.parse((await zip.entryData('modrinth.index.json')).toString('utf8')) as ModrinthManifest
        } finally {
            await zip.close()
        }
    }

    public async enrichServer(createServerResult: CreateServerResult, manifest: ModrinthManifest): Promise<void> {
        log.debug('Enriching server from Modrinth pack.')

        const zip = new StreamZip.async({ file: this.packPath })
        try {
            for (const prefix of ['overrides', 'client-overrides', 'server-overrides']) {
                try {
                    await zip.extract(prefix, createServerResult.miscFileContainer)
                } catch {
                    // Optional override directories are not guaranteed to exist.
                }
            }
        } finally {
            await zip.close()
        }

        if (createServerResult.modContainer == null) {
            log.warn('No mod container detected for this server. Mod files will be placed under misc files.')
        }

        const requiredModPath = createServerResult.modContainer != null
            ? resolve(createServerResult.modContainer, ToggleableNamespace.REQUIRED)
            : undefined
        const optionalModPath = createServerResult.modContainer != null
            ? resolve(createServerResult.modContainer, ToggleableNamespace.OPTIONAL_ON)
            : undefined
        if (requiredModPath) {
            await mkdirs(requiredModPath)
        }
        if (optionalModPath) {
            await mkdirs(optionalModPath)
        }

        for (const file of manifest.files) {
            if (file.downloads.length === 0) {
                log.warn(`Skipping ${file.path}: no download URLs in manifest.`)
                continue
            }

            const url = file.downloads[0]
            log.debug(`Downloading ${file.path} from ${url}`)

            let targetPath: string
            const normalizedPath = file.path.replaceAll('\\', '/')
            const isModFile = normalizedPath.startsWith('mods/')
            if (isModFile && requiredModPath && optionalModPath) {
                const fileName = normalizedPath.substring(normalizedPath.lastIndexOf('/') + 1)
                const clientEnv = file.env?.client ?? 'required'
                const baseDir = clientEnv === 'optional' ? optionalModPath : requiredModPath
                targetPath = join(baseDir, fileName)
            } else {
                targetPath = join(createServerResult.miscFileContainer, normalizedPath)
            }

            await mkdirs(dirname(targetPath))
            const downloadStream = got.stream(url)
            const fileWriterStream = createWriteStream(targetPath)
            await pipeline(downloadStream, fileWriterStream)
        }
    }
}

