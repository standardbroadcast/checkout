import * as core from '@actions/core'
import * as fsHelper from './fs-helper'
import * as github from '@actions/github'
import * as path from 'path'
import {ISourceSettings} from './git-source-provider'

export function getInputs(): ISourceSettings {
  const result = ({} as unknown) as ISourceSettings

  // GitHub workspace
  let githubWorkspacePath = process.env['GITHUB_WORKSPACE']
  if (!githubWorkspacePath) {
    throw new Error('GITHUB_WORKSPACE not defined')
  }
  githubWorkspacePath = path.resolve(githubWorkspacePath)
  core.debug(`GITHUB_WORKSPACE = '${githubWorkspacePath}'`)
  fsHelper.directoryExistsSync(githubWorkspacePath, true)

  // Qualified repository
  const qualifiedRepository =
    core.getInput('repository') ||
    `${github.context.repo.owner}/${github.context.repo.repo}`
  core.debug(`qualified repository = '${qualifiedRepository}'`)
  const splitRepository = qualifiedRepository.split('/')
  if (
    splitRepository.length !== 2 ||
    !splitRepository[0] ||
    !splitRepository[1]
  ) {
    throw new Error(
      `Invalid repository '${qualifiedRepository}'. Expected format {owner}/{repo}.`
    )
  }
  result.repositoryOwner = splitRepository[0]
  result.repositoryName = splitRepository[1]

  // Repository path
  result.repositoryPath = core.getInput('path') || '.'
  result.repositoryPath = path.resolve(
    githubWorkspacePath,
    result.repositoryPath
  )
  if (
    !(result.repositoryPath + path.sep).startsWith(
      githubWorkspacePath + path.sep
    )
  ) {
    throw new Error(
      `Repository path '${result.repositoryPath}' is not under '${githubWorkspacePath}'`
    )
  }

  // Workflow repository?
  const isWorkflowRepository =
    qualifiedRepository.toUpperCase() ===
    `${github.context.repo.owner}/${github.context.repo.repo}`.toUpperCase()

  // Source branch, source version
  result.ref = core.getInput('ref')
  if (!result.ref) {
    if (isWorkflowRepository) {
      result.ref = github.context.ref
      result.commit = github.context.sha
    }

    if (!result.ref && !result.commit) {
      result.ref = 'refs/heads/master'
    }
  }
  // SHA?
  else if (result.ref.match(/^[0-9a-fA-F]{40}$/)) {
    result.commit = result.ref
    result.ref = ''
  }
  core.debug(`ref = '${result.ref}'`)
  core.debug(`commit = '${result.commit}'`)

  // Clean
  result.clean = (core.getInput('clean') || 'true').toUpperCase() === 'TRUE'
  core.debug(`clean = ${result.clean}`)

  // Submodules
  if (core.getInput('submodules')) {
    throw new Error(
      "The input 'submodules' is not supported in actions/checkout@v2"
    )
  }

  // Fetch depth
  result.fetchDepth = Math.floor(Number(core.getInput('fetch-depth') || '1'))
  if (isNaN(result.fetchDepth) || result.fetchDepth < 0) {
    result.fetchDepth = 0
  }
  core.debug(`fetch depth = ${result.fetchDepth}`)

  // LFS
  result.lfs = (core.getInput('lfs') || 'false').toUpperCase() === 'TRUE'
  core.debug(`lfs = ${result.lfs}`)

  // Access token
  result.accessToken = core.getInput('token')

  return result
}
