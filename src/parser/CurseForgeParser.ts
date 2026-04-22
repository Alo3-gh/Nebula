import { createWriteStream } from 'fs'
import { mkdirs } from 'fs-extra/esm'
import got from 'got'
import StreamZip from 'node-stream-zip'
import { join, resolve } from 'path'
import { pipeline } from 'stream/promises'
import { ToggleableNamespace } from '../structure/spec_model/module/ToggleableModule.struct.js'
import { CreateServerResult } from '../structure/spec_model/Server.struct.js'
import { LoggerUtil } from '../util/LoggerUtil.js'

const log = LoggerUtil.getLogger('CurseForgeParser')

// No idea if this is right
export interface CurseForgeManifest {
    minecraft: {
        version: string
        modLoaders: {
            id: string
            primary: boolean
        }[]
    }
    manifestType: string
    manifestVersion: number
    name: string
    version: string
    author: string
    files: {
        projectID: number
        fileID: number
        required: boolean
    }[]
    overrides: string
}

export interface CurseForgeModResponse {
    data: {
        id: number
        gameId: number
        name: string
        slug: string
        classId?: number
        links?: {
            websiteUrl?: string
        }
        // There are more fields that we don't use right now.
    }
}

export interface CurseForgeModFileResponse {
    data: {
        id: number
        gameId: number
        isAvailable: boolean
        displayName: string
        fileName: string
        downloadUrl: string
        // There are more fields that we don't use right now.
    }
}


export class CurseForgeParser {

    private static resolveMinecraftProjectSection(classId: number | undefined): string {
        // Known top-level Minecraft sections on CurseForge.
        // Fallback keeps previous behavior for unknown classes.
        switch (classId) {
            case 6:
                return 'mc-mods'
            case 12:
                return 'texture-packs'
            case 17:
                return 'worlds'
            case 4546:
                return 'modpacks'
            case 6945:
                return 'data-packs'
            default:
                return 'mc-mods'
        }
    }

    private static buildProjectDownloadPageUrl(modInfo: CurseForgeModResponse['data'], fileId: number): string {
        const websiteUrl = modInfo.links?.websiteUrl?.replace(/\/+$/, '')
        if (websiteUrl != null && websiteUrl.length > 0) {
            return `${websiteUrl}/download/${fileId}`
        }

        const section = CurseForgeParser.resolveMinecraftProjectSection(modInfo.classId)
        return `https://www.curseforge.com/minecraft/${section}/${modInfo.slug}/download/${fileId}`
    }

    private static cfClient: ReturnType<typeof got.extend> | null = null

    private static getCfClient(): ReturnType<typeof got.extend> {
        if (CurseForgeParser.cfClient != null) {
            return CurseForgeParser.cfClient
        }

        const apiKey = process.env.CURSEFORGE_API_KEY
        if (apiKey == null || apiKey.trim().length === 0) {
            throw new Error('Missing CURSEFORGE_API_KEY in .env for CurseForge API access.')
        }

        CurseForgeParser.cfClient = got.extend({
            prefixUrl: 'https://api.curseforge.com/v1',
            responseType: 'json',
            headers: {
                'X-API-KEY': apiKey
            }
        })

        return CurseForgeParser.cfClient
    }

    private modpackDir: string
    private zipPath: string

    constructor(
        private absoluteRoot: string,
        private zipFileName: string
    ) {
        this.modpackDir = join(absoluteRoot, 'modpacks', 'curseforge')
        this.zipPath = join(this.modpackDir, zipFileName)
    }

    public async init(): Promise<void> {
        await mkdirs(this.modpackDir)
    }

    public async getModpackManifest(): Promise<CurseForgeManifest> {

        const zip = new StreamZip.async({ file: this.zipPath })
        return JSON.parse((await zip.entryData('manifest.json')).toString('utf8')) as CurseForgeManifest
    }

    public async enrichServer(createServerResult: CreateServerResult, manifest: CurseForgeManifest): Promise<void> {
        log.debug('Enriching server.')

        // Extract overrides
        const zip = new StreamZip.async({ file: this.zipPath })
        try {
            if(manifest.overrides) {
                await zip.extract(manifest.overrides, createServerResult.miscFileContainer)
            }
        }
        finally {
            await zip.close()
        }

        if(createServerResult.modContainer) {
            const requiredPath = resolve(createServerResult.modContainer, ToggleableNamespace.REQUIRED)
            const optionalPath = resolve(createServerResult.modContainer, ToggleableNamespace.OPTIONAL_ON)
            await mkdirs(requiredPath)
            await mkdirs(optionalPath)

            const disallowedFiles: { name: string, fileName: string, url: string }[] = []

            // Download mods
            for(const file of manifest.files) {
                log.debug(`Processing - Mod: ${file.projectID}, File: ${file.fileID}`)
                const fileInfo = (await CurseForgeParser.getCfClient().get(`mods/${file.projectID}/files/${file.fileID}`) as { body: CurseForgeModFileResponse }).body
                log.debug(`Downloading ${fileInfo.data.fileName}`)
                
                let dir: string
                const fileNameLower = fileInfo.data.fileName.toLowerCase()
                if(fileNameLower.endsWith('jar')) {
                    dir = file.required ? requiredPath : optionalPath
                }
                else if(fileNameLower.endsWith('zip')) {
                    // Assume it's a resource pack.
                    dir = join(createServerResult.miscFileContainer, 'resourcepacks')
                    await mkdirs(dir)
                }
                else {
                    dir = createServerResult.miscFileContainer
                }

                const thirdPartyDisallowed = fileInfo.data.downloadUrl == null
                if(thirdPartyDisallowed) {

                    log.warn(`${fileInfo.data.fileName} is not available for 3rd-party download through the curseforge API!`)
                    const modInfo = (await CurseForgeParser.getCfClient().get(`mods/${file.projectID}`) as { body: CurseForgeModResponse }).body
                    disallowedFiles.push({
                        name: modInfo.data.name,
                        fileName: fileInfo.data.fileName,
                        url: CurseForgeParser.buildProjectDownloadPageUrl(modInfo.data, file.fileID)
                    })

                } else {
                    const downloadStream = got.stream(fileInfo.data.downloadUrl)
                    const fileWriterStream = createWriteStream(join(dir, fileInfo.data.fileName))

                    await pipeline(downloadStream, fileWriterStream)
                }
                
            }

            if(disallowedFiles.length > 0) {

                log.error('============================================')
                log.error('\x1b[41mWARNING\x1b[0m')
                log.error(`${disallowedFiles.length} files declared by this modpack do not permit 3rd-party downloads.`)
                log.error('They MUST be downloaded manually.')
                log.error('The mods and their download urls will be listed below.')
                log.error('============================================')

                for(const file of disallowedFiles) {
                    log.error(`${file.name} (${file.fileName}) - \x1b[32m${file.url}\x1b[0m`)
                }

                log.error('============================================')
                log.error('YOUR MODPACK IS NOT FULLY GENERATED!')
                log.error('MANUAL ACTION REQUIRED! SCROLL UP AND READ THE WARNING!')
                log.error('============================================')
            }

        }
    }

}