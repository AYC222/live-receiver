/*
**  Live Video Experience (LiVE)
**  Copyright (c) 2020 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  external requirements  */
const electron     = require("electron")
const fs           = require("fs")
const os           = require("os")
const path         = require("path")
const AdmZip       = require("adm-zip")
const got          = require("got")
const tmp          = require("tmp")
const dayjs        = require("dayjs")
const mkdirp       = require("mkdirp")
const UpdateHelper = require("update-helper")

/*  internal requirements  */
const pjson        = require("./package.json")

/*  export the API  */
module.exports = class Update {
    constructor (options = {}) {
        /*  determine options  */
        const project = "https://github.com/rse/live-receiver"
        this.options = Object.assign({
            urlDist:    `${project}/releases/download/%V/LiVE-Receiver-%S-x64.zip`,
            urlVersion: `${project}/raw/master/VERSION.md`
        }, options)

        /*  determine absolute path to our own application file  */
        this.app = ""
        if (electron.app.isPackaged) {
            if (os.platform() === "win32") {
                /*  under Windows we are a portable app "LiVE-Receiver.exe"
                    and Electron Builder provides us the direct path to it  */
                this.app = path.resolve(process.env.PORTABLE_EXECUTABLE_FILE)
            }
            else if (os.platform() === "darwin") {
                /*  under macOS we are a regular app "LiVE-Receiver.app"
                    but we have to step up to the base directory from its
                    actual embedded executable "Contents/MacOS/LiVE-Receiver"  */
                this.app = path.resolve(path.join(electron.app.getPath("exe"), "..", "..", ".."))
            }
        }

        /*  initialize with unknown available versions  */
        this.versions = []

        /*  initialize with unknown target versions  */
        this.versionRunning     = undefined
        this.versionForthcoming = undefined
        this.versionCurrent     = undefined
    }

    /*  check whether we are really updateable  */
    async updateable () {
        if (!electron.app.isPackaged)
            return false
        if (this.app === "")
            return false
        if (!this.app.match(/^(.+)\.(exe|app)$/))
            return false
        const accessible = await fs.promises.access(this.app, fs.constants.W_OK)
            .then(() => true).catch(() => false)
        if (!accessible)
            return false
        return true
    }

    /*  check for available update versions  */
    async check (progress) {
        /*  determine available versions  */
        if (progress)
            progress("downloading application version information", 0.0)
        const req = got({
            method:       "GET",
            url:          this.options.urlVersion,
            headers:      { "User-Agent": `${pjson.name}/${pjson.version}` },
            responseType: "text",
            https:        { rejectUnauthorized: false }
        })
        if (progress) {
            req.on("downloadProgress", (p) => {
                let completed = p.transferred / p.total
                if (isNaN(completed))
                    completed = 0
                progress("downloading application version information", completed)
            })
        }
        const response = await req
        const md = response.body
        this.versions = []
        md.replace(
            /^\|\s+([0-9]+(?:(?:a|b|rc|\.)[0-9]+)*)\s+\|\s+(\d{4}-\d{2}-\d{2})\s+\|\s+(\S+)\s+\|\s*$/mg,
            (_, version, date, type) => { this.versions.push({ version, date, type }) }
        )
        if (progress)
            progress("downloading application version information", 1.0)

        /*  determine running version  */
        this.versionRunning = this.versions.find((v) => v.version === pjson.version)

        /*  determine latest current version  */
        this.versionCurrent = this.versions.find((v) => v.type === "current")

        /*  determine information about forthcoming version  */
        this.versionForthcoming = this.versions.find((v) => v.type === "forthcoming")

        /*  ensure the current version is newer or same than the running version  */
        if (this.versionCurrent && this.versionRunning) {
            const d1 = dayjs(this.versionCurrent.date)
            const d2 = dayjs(this.versionRunning.date)
            if (d1.isBefore(d2))
                this.versionCurrent = this.versionRunning
        }

        /*  ensure the forthcoming version is newer or same than the current version  */
        if (this.versionForthcoming && this.versionCurrent) {
            const d1 = dayjs(this.versionForthcoming.date)
            const d2 = dayjs(this.versionCurrent.date)
            if (d1.isBefore(d2))
                this.versionForthcoming = undefined
        }

        /*  return determined versions and whether we are updateable  */
        return {
            running:     this.versionRunning,
            current:     this.versionCurrent,
            forthcoming: this.versionForthcoming
        }
    }

    /*  perform update  */
    async update (version, progress) {
        /*  sanity check situation  */
        const updateable = await this.updateable()
        if (!updateable)
            throw new Error("we are not able to update the application")

        /*  download application distribution ZIP archive  */
        let sys
        if (os.platform() === "win32")
            sys = "win"
        else if (os.platform() === "darwin")
            sys = "mac"
        const url = this.options.urlDist
            .replace(/%V/g, version)
            .replace(/%S/g, sys)
        if (progress)
            progress("downloading application distribution", 0.0)
        const req = got({
            method:       "GET",
            url:          url,
            headers:      { "User-Agent": `${pjson.name}/${pjson.version}` },
            responseType: "buffer"
        })
        if (progress) {
            req.on("downloadProgress", (p) => {
                let completed = p.transferred / p.total
                if (isNaN(completed))
                    completed = 0
                progress("downloading application distribution", completed)
            })
        }
        const response = await req
        const tmpfile = tmp.fileSync()
        await fs.promises.writeFile(tmpfile.name, response.body, { encoding: null })
        if (progress)
            progress("downloading application distribution", 1.0)

        /*  extract application distribution ZIP archive  */
        if (progress)
            progress("extracting application distribution", 0.0)
        const tmpdir = tmp.dirSync()
        const zip = new AdmZip(tmpfile.name)
        const dirCreated = {}
        const entries = zip.getEntries()
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]
            if (progress)
                progress("extracting application distribution", i / entries.length)

            /*  determine result file path on filesystem  */
            const filePath = path.join(tmpdir.name, entry.entryName)

            /*  determine directory path and automatically create missing directories  */
            const dirPath = entry.isDirectory ? filePath : path.dirname(filePath)
            if (!dirCreated[dirPath]) {
                await mkdirp(dirPath)
                dirCreated[dirPath] = true
            }

            /*  create resulting entry  */
            if (((entry.attr >> 28) & 0x0F) === 10) {
                /*  case 1: symbolic link  */
                const target = zip.readFile(entry).toString()
                await fs.promises.symlink(target, filePath)
                if (os.platform() === "darwin")
                    await fs.promises.lchmod(filePath, (entry.attr >> 16) & 0x1ff)
            }
            else if (!entry.isDirectory) {
                /*  case 2: regular file  */
                const data = zip.readFile(entry)
                await fs.promises.writeFile(filePath, data, { encoding: null })
                await fs.promises.chmod(filePath, (entry.attr >> 16) & 0x1ff)
            }
        }
        if (progress)
            progress("extracting application distribution", 1.0)
        tmpfile.removeCallback()

        /*  start background process to update application executable  */
        if (progress)
            progress("updating application executable", 0.0)

        /*  final sanity check  */
        let from
        if (os.platform() === "win32")
            from = path.join(tmpdir.name, "LiVE-Receiver.exe")
        else if (os.platform() === "darwin")
            from = path.join(tmpdir.name, "LiVE-Receiver.app")
        const accessible = await fs.promises.access(from, fs.constants.F_OK | fs.constants.R_OK)
            .then(() => true).catch(() => false)
        if (!accessible)
            throw new Error("cannot find application executable in downloaded content")

        /*  kill/replace/restart ourself  */
        const updateHelper = new UpdateHelper({
            kill:     process.pid,
            wait:     1000,
            rename:   true,
            source:   from,
            target:   this.app,
            [os.platform() === "darwin" ? "open" : "execute"]: this.app,
            cleanup:  tmpdir.name,
            progress: progress
        })
        await updateHelper.update()
    }

    /*  perform cleanup  */
    async cleanup () {
        /*  remove old update-helper after update  */
        const updateHelper = new UpdateHelper()
        await updateHelper.cleanup()
    }
}
