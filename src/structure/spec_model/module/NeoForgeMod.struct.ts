import StreamZip from 'node-stream-zip'
import toml from 'toml'
import { Type } from 'helios-distribution-types'
import { capitalize } from '../../../util/StringUtils.js'
import { ModsToml } from '../../../model/forge/ModsToml.js'
import { MinecraftVersion } from '../../../util/MinecraftVersion.js'
import { BaseModStructure } from './Mod.struct.js'
import { UntrackedFilesOption } from '../../../model/nebula/ServerMeta.js'

export class NeoForgeModStructure extends BaseModStructure<ModsToml> {

    public static readonly IMPLEMENTATION_VERSION_REGEX = /^Implementation-Version: (.+)[\r\n]/

    constructor(
        absoluteRoot: string,
        relativeRoot: string,
        baseUrl: string,
        minecraftVersion: MinecraftVersion,
        untrackedFiles: UntrackedFilesOption[]
    ) {
        // NeoForge 1.20.3+ no longer supports loading distribution mods through
        // FML's Maven mod list. Keep these as managed files so Helios places
        // them in the instance's normal `mods` directory, where NeoForge's
        // standard mods-folder locator can discover service and JarJar mods.
        super(absoluteRoot, relativeRoot, 'neoforgemods', baseUrl, minecraftVersion, Type.File, untrackedFiles)
    }

    public getLoggerName(): string {
        return 'NeoForgeModStructure'
    }

    protected async getModuleId(name: string, _path: string): Promise<string> {
        const fmData = await this.getModMetadata(name, _path)
        // Type.File modules are installed by artifact.path and are not resolved
        // through Maven. Do not use TypeMetadata's undefined File extension.
        return `generated.neoforge:${fmData.mods[0].modId}:${fmData.mods[0].version}`
    }

    protected async getModuleName(name: string, _path: string): Promise<string> {
        return capitalize((await this.getModMetadata(name, _path)).mods[0].displayName)
    }

    protected processZip(zip: StreamZip, name: string): ModsToml {
        let raw: Buffer | undefined
        try {
            raw = zip.entryDataSync('META-INF/neoforge.mods.toml')
        } catch {
            // Older cross-loader builds may still use the Forge metadata name.
            try {
                raw = zip.entryDataSync('META-INF/mods.toml')
            } catch {
                // ignored
            }
        }

        if (raw) {
            try {
                this.modMetadata[name] = toml.parse(raw.toString()) as ModsToml
            } catch {
                this.logger.error(`NeoForgeMod ${name} contains an invalid NeoForge mod metadata file.`)
            }
        } else {
            this.logger.warn(`NeoForgeMod ${name} does not contain NeoForge mod metadata; using filename fallback.`)
        }

        const crudeInference = this.attemptCrudeInference(name)
        if(this.modMetadata[name] == null) {
            this.modMetadata[name] = {
                modLoader: 'javafml',
                loaderVersion: '',
                mods: [{
                    modId: crudeInference.name.toLowerCase(),
                    version: crudeInference.version,
                    displayName: crudeInference.name,
                    description: ''
                }]
            }
        }

        for(const entry of this.modMetadata[name].mods) {
            if (entry.version === '${file.jarVersion}') {
                let version = crudeInference.version
                try {
                    const manifest = zip.entryDataSync('META-INF/MANIFEST.MF')
                    for (const key of manifest.toString().split('\n')) {
                        const match = NeoForgeModStructure.IMPLEMENTATION_VERSION_REGEX.exec(key)
                        if (match != null) {
                            version = match[1]
                        }
                    }
                } catch {
                    // keep inferred version
                }
                entry.version = version
            }
        }

        return this.modMetadata[name]
    }

    protected async getModulePath(name: string): Promise<string> {
        return `mods/${name}`
    }
}
