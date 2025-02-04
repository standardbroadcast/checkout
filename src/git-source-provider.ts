import * as core from '@actions/core'
import * as coreCommand from '@actions/core/lib/command'
import * as fs from 'fs'
import * as fsHelper from './fs-helper'
import * as gitCommandManager from './git-command-manager'
import * as io from '@actions/io'
import * as path from 'path'
import * as refHelper from './ref-helper'
import {IGitCommandManager} from './git-command-manager'

const authConfigKey = `http.https://github.com/.extraheader`

export interface ISourceSettings {
  repositoryPath: string
  repositoryOwner: string
  repositoryName: string
  ref: string
  commit: string
  clean: boolean
  fetchDepth: number
  lfs: boolean
  accessToken: string
}

export async function getSource(settings: ISourceSettings): Promise<void> {
  core.info(
    `Syncing repository: ${settings.repositoryOwner}/${settings.repositoryName}`
  )
  const repositoryUrl = `https://github.com/${encodeURIComponent(
    settings.repositoryOwner
  )}/${encodeURIComponent(settings.repositoryName)}`

  // Remove conflicting file path
  if (fsHelper.fileExistsSync(settings.repositoryPath)) {
    await io.rmRF(settings.repositoryPath)
  }

  // Create directory
  let isExisting = true
  if (!fsHelper.directoryExistsSync(settings.repositoryPath)) {
    isExisting = false
    await io.mkdirP(settings.repositoryPath)
  }

  // Git command manager
  core.info(`Working directory is '${settings.repositoryPath}'`)
  const git = await gitCommandManager.CreateCommandManager(
    settings.repositoryPath,
    settings.lfs
  )

  // Try prepare existing directory, otherwise recreate
  if (
    isExisting &&
    !(await tryPrepareExistingDirectory(
      git,
      settings.repositoryPath,
      repositoryUrl,
      settings.clean
    ))
  ) {
    // Delete the contents of the directory. Don't delete the directory itself
    // since it may be the current working directory.
    core.info(`Deleting the contents of '${settings.repositoryPath}'`)
    for (const file of await fs.promises.readdir(settings.repositoryPath)) {
      await io.rmRF(path.join(settings.repositoryPath, file))
    }
  }

  // Initialize the repository
  if (
    !fsHelper.directoryExistsSync(path.join(settings.repositoryPath, '.git'))
  ) {
    await git.init()
    await git.remoteAdd('origin', repositoryUrl)
  }

  // Disable automatic garbage collection
  if (!(await git.tryDisableAutomaticGarbageCollection())) {
    core.warning(
      `Unable to turn off git automatic garbage collection. The git fetch operation may trigger garbage collection and cause a delay.`
    )
  }

  // Remove possible previous extraheader
  await removeGitConfig(git, authConfigKey)

  // Add extraheader (auth)
  const base64Credentials = Buffer.from(
    `x-access-token:${settings.accessToken}`,
    'utf8'
  ).toString('base64')
  core.setSecret(base64Credentials)
  const authConfigValue = `AUTHORIZATION: basic ${base64Credentials}`
  await git.config(authConfigKey, authConfigValue)

  // LFS install
  if (settings.lfs) {
    await git.lfsInstall()
  }

  // Fetch
  const refSpec = refHelper.getRefSpec(settings.ref, settings.commit)
  await git.fetch(settings.fetchDepth, refSpec)

  // Checkout info
  const checkoutInfo = await refHelper.getCheckoutInfo(
    git,
    settings.ref,
    settings.commit
  )

  // LFS fetch
  // Explicit lfs-fetch to avoid slow checkout (fetches one lfs object at a time).
  // Explicit lfs fetch will fetch lfs objects in parallel.
  if (settings.lfs) {
    await git.lfsFetch(checkoutInfo.startPoint || checkoutInfo.ref)
  }

  // Checkout
  await git.checkout(checkoutInfo.ref, checkoutInfo.startPoint)

  // Dump some info about the checked out commit
  await git.log1()

  // Set intra-task state for cleanup
  coreCommand.issueCommand(
    'save-state',
    {name: 'repositoryPath'},
    settings.repositoryPath
  )
}

export async function cleanup(repositoryPath: string): Promise<void> {
  // Repo exists?
  if (!fsHelper.fileExistsSync(path.join(repositoryPath, '.git', 'config'))) {
    return
  }
  fsHelper.directoryExistsSync(repositoryPath, true)

  // Remove the config key
  const git = await gitCommandManager.CreateCommandManager(
    repositoryPath,
    false
  )
  await removeGitConfig(git, authConfigKey)
}

async function tryPrepareExistingDirectory(
  git: IGitCommandManager,
  repositoryPath: string,
  repositoryUrl: string,
  clean: boolean
): Promise<boolean> {
  // Fetch URL does not match
  if (
    !fsHelper.directoryExistsSync(path.join(repositoryPath, '.git')) ||
    repositoryUrl !== (await git.tryGetFetchUrl())
  ) {
    return false
  }

  // Delete any index.lock and shallow.lock left by a previously canceled run or crashed git process
  const lockPaths = [
    path.join(repositoryPath, '.git', 'index.lock'),
    path.join(repositoryPath, '.git', 'shallow.lock')
  ]
  for (const lockPath of lockPaths) {
    try {
      await io.rmRF(lockPath)
    } catch (error) {
      core.debug(`Unable to delete '${lockPath}'. ${error.message}`)
    }
  }

  try {
    // Checkout detached HEAD
    if (!(await git.isDetached())) {
      await git.checkoutDetach()
    }

    // Remove all refs/heads/*
    let branches = await git.branchList(false)
    for (const branch of branches) {
      await git.branchDelete(false, branch)
    }

    // Remove all refs/remotes/origin/* to avoid conflicts
    branches = await git.branchList(true)
    for (const branch of branches) {
      await git.branchDelete(true, branch)
    }
  } catch (error) {
    core.warning(
      `Unable to prepare the existing repository. The repository will be recreated instead.`
    )
    return false
  }

  // Clean
  if (clean) {
    let succeeded = true
    if (!(await git.tryClean())) {
      core.debug(
        `The clean command failed. This might be caused by: 1) path too long, 2) permission issue, or 3) file in use. For futher investigation, manually run 'git clean -ffdx' on the directory '${repositoryPath}'.`
      )
      succeeded = false
    } else if (!(await git.tryReset())) {
      succeeded = false
    }

    if (!succeeded) {
      core.warning(
        `Unable to clean or reset the repository. The repository will be recreated instead.`
      )
    }

    return succeeded
  }

  return true
}

async function removeGitConfig(
  git: IGitCommandManager,
  configKey: string
): Promise<void> {
  if (
    (await git.configExists(configKey)) &&
    !(await git.tryConfigUnset(configKey))
  ) {
    // Load the config contents
    core.warning(
      `Failed to remove '${configKey}' from the git config. Attempting to remove the config value by editing the file directly.`
    )
    const configPath = path.join(git.getWorkingDirectory(), '.git', 'config')
    fsHelper.fileExistsSync(configPath)
    let contents = fs.readFileSync(configPath).toString() || ''

    // Filter - only includes lines that do not contain the config key
    const upperConfigKey = configKey.toUpperCase()
    const split = contents
      .split('\n')
      .filter(x => !x.toUpperCase().includes(upperConfigKey))
    contents = split.join('\n')

    // Rewrite the config file
    fs.writeFileSync(configPath, contents)
  }
}
