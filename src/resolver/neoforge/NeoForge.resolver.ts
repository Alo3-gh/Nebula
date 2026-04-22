import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { lstat, readFile, readdir, writeFile } from 'fs/promises'
import { copy, mkdirs, pathExists, remove } from 'fs-extra/esm'
import got from 'got'
import { Module, Type } from 'helios-distribution-types'
import { basename, dirname, join } from 'path'
import { RepoStructure } from '../../structure/repo/Repo.struct.js'
import { MavenUtil } from '../../util/MavenUtil.js'
import { MinecraftVersion } from '../../util/MinecraftVersion.js'
import { LoggerUtil } from '../../util/LoggerUtil.js'
import { JavaUtil } from '../../util/java/JavaUtil.js'
import { BaseResolver } from '../BaseResolver.js'

interface NeoForgeVersionManifest {
    arguments?: {
        game?: string[]
    }
    libraries: {
        name: string
        downloads: {
            artifact: {
                path: string
                sha1: string
                url: string
            }
        }
    }[]
}

export class NeoForgeResolver extends BaseResolver {

    private static readonly logger = LoggerUtil.getLogger('NeoForgeResolver')

    protected repoStructure: RepoStructure
    private readonly remoteRepository = 'https://maven.neoforged.net/releases/'
    private readonly artifactVersion: string

    constructor(
        absoluteRoot: string,
        relativeRoot: string,
        baseUrl: string,
        private readonly loaderVersion: string,
        private readonly minecraftVersion: MinecraftVersion
    ) {
        super(absoluteRoot, relativeRoot, baseUrl)
        this.repoStructure = new RepoStructure(absoluteRoot, relativeRoot, 'neoforge')
        this.artifactVersion = loaderVersion
    }

    public async getModule(): Promise<Module> {
        return this.resolveViaInstaller()
    }

    private async resolveViaInstaller(): Promise<Module> {
        const libRepo = this.repoStructure.getLibRepoStruct()
        const versionRepo = this.repoStructure.getVersionRepoStruct()
        await this.assertNeoForgeMavenReachable(this.artifactVersion)
        const installerPath = libRepo.getArtifactByComponents('net.neoforged', 'neoforge', this.artifactVersion, 'installer', 'jar')
        const installerMavenId = `net.neoforged:neoforge:${this.artifactVersion}:installer`
        let installerOk = await libRepo.artifactExists(installerPath) && await this.isValidJar(installerPath)
        if (!installerOk) {
            await libRepo.downloadArtifactById(this.remoteRepository, installerMavenId, 'jar')
            installerOk = await this.isValidJar(installerPath)
        }
        if (!installerOk) {
            throw new Error(`NeoForge installer could not be downloaded as a valid jar from maven.neoforged.net. The host may be blocked in your network and require proxy access.`)
        }

        const installRoot = join(this.repoStructure.getCacheDirectory(), 'neoforge', this.artifactVersion)
        const versionManifestPath = await this.ensureInstalled(installerPath, installRoot)

        const versionManifestBuf = await readFile(versionManifestPath)
        const versionManifest = JSON.parse(versionManifestBuf.toString()) as NeoForgeVersionManifest

        const versionManifestDest = versionRepo.getVersionManifest(this.minecraftVersion, this.loaderVersion)
        await mkdirs(dirname(versionManifestDest))
        await writeFile(versionManifestDest, versionManifestBuf)

        const modules: Module[] = [{
            id: versionRepo.getFileName(this.minecraftVersion, this.loaderVersion),
            name: 'NeoForge (version.json)',
            type: Type.VersionManifest,
            artifact: this.generateArtifact(
                versionManifestBuf,
                await lstat(versionManifestDest),
                versionRepo.getVersionManifestURL(this.baseUrl, this.minecraftVersion, this.loaderVersion)
            )
        }]

        const mainMavenId = this.resolveMainModuleId(versionManifest)
        const mainMaven = MavenUtil.getMavenComponents(mainMavenId)
        const mainLocalPath = libRepo.getArtifactById(mainMavenId, 'jar')

        for(const lib of versionManifest.libraries) {
            const localPath = libRepo.getArtifactById(lib.name, 'jar')
            let libBuf: Buffer
            const mavenComponents = MavenUtil.getMavenComponents(lib.name)
            if (!await libRepo.artifactExists(localPath)) {
                await libRepo.downloadArtifactDirect(lib.downloads.artifact.url, lib.downloads.artifact.path)
                libBuf = await readFile(localPath)
            } else {
                libBuf = await readFile(localPath)
                const sha1 = createHash('sha1').update(libBuf).digest('hex')
                if (sha1 !== lib.downloads.artifact.sha1) {
                    await libRepo.downloadArtifactDirect(lib.downloads.artifact.url, lib.downloads.artifact.path)
                    libBuf = await readFile(localPath)
                }
            }

            const stats = await lstat(localPath)
            modules.push({
                id: MavenUtil.mavenComponentsToIdentifier(
                    mavenComponents.group,
                    mavenComponents.artifact,
                    mavenComponents.version,
                    mavenComponents.classifier,
                    'jar'
                ),
                name: `NeoForge (${mavenComponents.artifact})`,
                type: Type.Library,
                artifact: this.generateArtifact(
                    libBuf,
                    stats,
                    libRepo.getArtifactUrlByComponents(
                        this.baseUrl,
                        mavenComponents.group,
                        mavenComponents.artifact,
                        mavenComponents.version,
                        mavenComponents.classifier,
                        'jar'
                    )
                )
            })
        }
        // Keep the official NeoForge client classifier available for production client provider.
        await this.pushOptionalClassifierModule(modules, libRepo, installRoot, 'client')
        await this.pushOptionalNeoFormClientModules(modules, libRepo, installRoot, versionManifest)
        if (!await this.isValidJar(mainLocalPath)) {
            const installLocalPath = join(
                installRoot,
                'libraries',
                'net',
                'neoforged',
                'neoforge',
                this.artifactVersion,
                `neoforge-${this.artifactVersion}-universal.jar`
            )
            if (await this.isValidJar(installLocalPath)) {
                await mkdirs(dirname(mainLocalPath))
                await copy(installLocalPath, mainLocalPath, { overwrite: true })
            }
        }
        if (!await this.isValidJar(mainLocalPath)) {
            await libRepo.downloadArtifactById(this.remoteRepository, mainMavenId, 'jar')
        }
        if (!await this.isValidJar(mainLocalPath)) {
            throw new Error(`NeoForge main module could not be resolved: ${mainMavenId}`)
        }

        const mainModule: Module = {
            id: mainMavenId,
            name: `NeoForge ${this.artifactVersion}`,
            type: Type.ForgeHosted,
            artifact: this.generateArtifact(
                await readFile(mainLocalPath),
                await lstat(mainLocalPath),
                libRepo.getArtifactUrlByComponents(
                    this.baseUrl,
                    mainMaven.group,
                    mainMaven.artifact,
                    mainMaven.version,
                    mainMaven.classifier,
                    'jar'
                )
            ),
            subModules: modules
        }

        return mainModule
    }

    // modern-only implementation for current integration target
    public isForVersion(version: MinecraftVersion, _libraryVersion: string): boolean {
        return version.isGreaterThanOrEqualTo(new MinecraftVersion('1.20.1'))
    }

    private async ensureInstalled(installerPath: string, installRoot: string): Promise<string> {
        let versionManifestPath = await this.findVersionManifest(installRoot)
        if (versionManifestPath != null) {
            return versionManifestPath
        }

        await remove(installRoot)
        await mkdirs(installRoot)

        const workingInstaller = join(installRoot, basename(installerPath))
        await copy(installerPath, workingInstaller, { overwrite: true })
        // NeoForge installer expects this file to exist in target directory.
        await writeFile(join(installRoot, 'launcher_profiles.json'), JSON.stringify({}))
        await this.executeInstaller(workingInstaller, installRoot)

        versionManifestPath = await this.findVersionManifest(installRoot)
        if (versionManifestPath == null) {
            throw new Error(`NeoForge installer did not produce a version manifest under ${installRoot}.`)
        }
        return versionManifestPath
    }

    private async findVersionManifest(installRoot: string): Promise<string | null> {
        const versionsRoot = join(installRoot, 'versions')
        if (!await pathExists(versionsRoot)) {
            return null
        }
        const candidates: string[] = []
        const entries = await readdir(versionsRoot, { withFileTypes: true })
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue
            }
            const candidatePath = join(versionsRoot, entry.name, `${entry.name}.json`)
            if (!await pathExists(candidatePath)) {
                continue
            }
            try {
                const parsed = JSON.parse((await readFile(candidatePath)).toString()) as NeoForgeVersionManifest
                if (this.isNeoForgeVersionManifest(parsed)) {
                    return candidatePath
                }
                if (Array.isArray(parsed.libraries)) {
                    candidates.push(candidatePath)
                }
            } catch {
                // continue search
            }
        }
        if (candidates.length > 0) {
            // Presence of only vanilla manifests typically means installer did not finish.
            return null
        }
        return null
    }

    private isNeoForgeVersionManifest(manifest: NeoForgeVersionManifest): boolean {
        if (!Array.isArray(manifest.libraries)) {
            return false
        }
        return manifest.libraries.some(x => x.name.startsWith('net.neoforged:') || x.name.startsWith('cpw.mods:'))
    }

    private resolveMainModuleId(manifest: NeoForgeVersionManifest): string {
        const neoforgeLibrary = manifest.libraries.find(x => x.name.startsWith(`net.neoforged:neoforge:${this.artifactVersion}`))
        if (neoforgeLibrary != null) {
            return neoforgeLibrary.name
        }
        // NeoForge version manifest may omit the main neoforge hosted jar.
        return `net.neoforged:neoforge:${this.artifactVersion}:universal`
    }

    private executeInstaller(installerJar: string, installRoot: string): Promise<void> {
        return new Promise((resolve, reject) => {
            NeoForgeResolver.logger.info('Running NeoForge installer in CLI mode.')
            NeoForgeResolver.logger.info(`Install root: ${installRoot}`)
            const child = spawn(JavaUtil.getJavaExecutable(), [
                '-jar',
                installerJar,
                '--install-client',
                installRoot
            ], {
                cwd: dirname(installerJar)
            })
            child.stdout.on('data', data => NeoForgeResolver.logger.info(data.toString('utf8').trim()))
            child.stderr.on('data', data => NeoForgeResolver.logger.error(data.toString('utf8').trim()))
            child.on('error', reject)
            child.on('close', code => {
                if (code === 0) {
                    resolve()
                } else {
                    reject(new Error(`NeoForge installer exited with code ${code}`))
                }
            })
        })
    }

    private async pushOptionalClassifierModule(
        modules: Module[],
        libRepo: RepoStructure['getLibRepoStruct'] extends () => infer T ? T : never,
        installRoot: string,
        classifier: 'client' | 'server'
    ): Promise<void> {
        const localPath = await this.ensureOptionalClassifierJar(libRepo, installRoot, classifier)
        if (localPath == null) {
            return
        }
        const buf = await readFile(localPath)
        const stats = await lstat(localPath)
        modules.push({
            id: `net.neoforged:neoforge:${this.artifactVersion}:${classifier}`,
            name: `NeoForge (${classifier})`,
            type: Type.Library,
            classpath: classifier === 'client',
            artifact: this.generateArtifact(
                buf,
                stats,
                libRepo.getArtifactUrlByComponents(this.baseUrl, 'net.neoforged', 'neoforge', this.artifactVersion, classifier, 'jar')
            )
        })
    }

    private async pushOptionalNeoFormClientModules(
        modules: Module[],
        libRepo: RepoStructure['getLibRepoStruct'] extends () => infer T ? T : never,
        installRoot: string,
        versionManifest: NeoForgeVersionManifest
    ): Promise<void> {
        const neoFormVersion = this.resolveNeoFormVersion(versionManifest)
        if (neoFormVersion == null) {
            NeoForgeResolver.logger.warn('NeoForm version was not found in version manifest args, skipping minecraft client classifiers.')
            return
        }
        const mcNeoFormVersion = `${this.minecraftVersion.toString()}-${neoFormVersion}`
        for (const classifier of ['srg', 'extra'] as const) {
            const localPath = await this.ensureOptionalMinecraftClientClassifierJar(libRepo, installRoot, mcNeoFormVersion, classifier)
            if (localPath == null) {
                continue
            }
            const buf = await readFile(localPath)
            const stats = await lstat(localPath)
            modules.push({
                id: `net.minecraft:client:${mcNeoFormVersion}:${classifier}`,
                name: `NeoForm client (${classifier})`,
                type: Type.Library,
                classpath: false,
                artifact: this.generateArtifact(
                    buf,
                    stats,
                    libRepo.getArtifactUrlByComponents(this.baseUrl, 'net.minecraft', 'client', mcNeoFormVersion, classifier, 'jar')
                )
            })
        }
    }

    private resolveNeoFormVersion(versionManifest: NeoForgeVersionManifest): string | null {
        const gameArgs = versionManifest.arguments?.game
        if (!Array.isArray(gameArgs)) {
            return null
        }
        for (let i = 0; i < gameArgs.length - 1; i++) {
            if (gameArgs[i] === '--fml.neoFormVersion' && typeof gameArgs[i + 1] === 'string' && gameArgs[i + 1].length > 0) {
                return gameArgs[i + 1]
            }
        }
        return null
    }

    private async ensureOptionalMinecraftClientClassifierJar(
        libRepo: RepoStructure['getLibRepoStruct'] extends () => infer T ? T : never,
        installRoot: string,
        mcNeoFormVersion: string,
        classifier: 'srg' | 'extra'
    ): Promise<string | null> {
        const expectedLocalPath = libRepo.getArtifactByComponents('net.minecraft', 'client', mcNeoFormVersion, classifier, 'jar')
        if (await this.isValidJar(expectedLocalPath)) {
            return expectedLocalPath
        }
        const installedLocalPath = join(
            installRoot,
            'libraries',
            'net',
            'minecraft',
            'client',
            mcNeoFormVersion,
            `client-${mcNeoFormVersion}-${classifier}.jar`
        )
        if (await this.isValidJar(installedLocalPath)) {
            await mkdirs(dirname(expectedLocalPath))
            await copy(installedLocalPath, expectedLocalPath, { overwrite: true })
            return await this.isValidJar(expectedLocalPath) ? expectedLocalPath : null
        }
        const optionalId = `net.minecraft:client:${mcNeoFormVersion}:${classifier}`
        if (await libRepo.headArtifactById(this.remoteRepository, optionalId, 'jar')) {
            await libRepo.downloadArtifactById(this.remoteRepository, optionalId, 'jar')
            if (await this.isValidJar(expectedLocalPath)) {
                return expectedLocalPath
            }
        }
        NeoForgeResolver.logger.warn(`NeoForm client ${classifier} jar is unavailable for ${mcNeoFormVersion}, skipping optional artifact.`)
        return null
    }


    private async ensureOptionalClassifierJar(
        libRepo: RepoStructure['getLibRepoStruct'] extends () => infer T ? T : never,
        installRoot: string,
        classifier: 'client' | 'server'
    ): Promise<string | null> {
        const expectedLocalPath = libRepo.getArtifactByComponents('net.neoforged', 'neoforge', this.artifactVersion, classifier, 'jar')
        if (await this.isValidJar(expectedLocalPath)) {
            return expectedLocalPath
        }

        const installedLocalPath = join(
            installRoot,
            'libraries',
            'net',
            'neoforged',
            'neoforge',
            this.artifactVersion,
            `neoforge-${this.artifactVersion}-${classifier}.jar`
        )
        if (await this.isValidJar(installedLocalPath)) {
            await mkdirs(dirname(expectedLocalPath))
            await copy(installedLocalPath, expectedLocalPath, { overwrite: true })
            return await this.isValidJar(expectedLocalPath) ? expectedLocalPath : null
        }

        const optionalId = `net.neoforged:neoforge:${this.artifactVersion}:${classifier}`
        if (await libRepo.headArtifactById(this.remoteRepository, optionalId, 'jar')) {
            await libRepo.downloadArtifactById(this.remoteRepository, optionalId, 'jar')
            if (await this.isValidJar(expectedLocalPath)) {
                return expectedLocalPath
            }
        }
        NeoForgeResolver.logger.warn(`NeoForge ${classifier} jar is unavailable, skipping optional artifact.`)
        return null
    }

    private async assertNeoForgeMavenReachable(version: string): Promise<void> {
        const installerRelative = `net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`
        const installerUrl = new URL(installerRelative, this.remoteRepository).toString()
        try {
            const response = await got.head(installerUrl, {
                timeout: {
                    request: 10000
                }
            })
            if (response.statusCode !== 200) {
                throw new Error(`Status ${response.statusCode}`)
            }
        } catch {
            throw new Error('maven.neoforged.net is not reachable from your environment (likely requires proxy). NeoForge distro generation is aborted.')
        }
    }

    private async isValidJar(filePath: string): Promise<boolean> {
        if (!await pathExists(filePath)) {
            return false
        }
        const buf = await readFile(filePath)
        // zip/jar magic bytes PK
        return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b
    }
}
