// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {Checker} from './third_party/tsetse/checker';
import * as path from 'path';
import * as ts from 'typescript';

import {ENABLED_RULES} from './rule_groups';
import {createEmptyExemptionList, ExemptionList, parseConformanceExemptionConfig} from './tsec_lib/exemption_config';
import {FORMAT_DIAGNOSTIC_HOST, reportDiagnostic, reportDiagnosticsWithSummary, reportErrorSummary} from './tsec_lib/report';
import {ExtendedParsedCommandLine, parseTsConfigFile} from './tsec_lib/tsconfig';

function isInBuildMode(cmdArgs: string[]) {
  // --build or -b has to be the first argument
  if (cmdArgs.length && cmdArgs[0].charAt(0) === '-') {
    const optionStart = cmdArgs[0].charAt(1) === '-' ? 2 : 1;
    const firstOption = cmdArgs[0].slice(optionStart);
    return firstOption === 'build' || firstOption === 'b';
  }
  return false;
}

function getTsConfigFilePath(projectPath?: string): string {
  let tsConfigFilePath: string;

  // TODO(b/169605827): To fully align with tsc, we should also search parent
  // directories of pwd until a tsconfig.json file is found.
  if (projectPath === undefined) projectPath = '.';

  if (ts.sys.directoryExists(projectPath)) {
    tsConfigFilePath = path.join(projectPath, 'tsconfig.json');
  } else {
    tsConfigFilePath = projectPath;
  }

  return tsConfigFilePath;
}

function performanceConformanceCheck(
    program: ts.Program,
    conformanceExemptionConfig: ExemptionList =
        createEmptyExemptionList()): ts.Diagnostic[] {
  const diagnostics = [...ts.getPreEmitDiagnostics(program)];

  // Create all enabled rules with corresponding exemption list entries.
  const conformanceChecker = new Checker(program);
  const conformanceRules = ENABLED_RULES.map(ruleCtr => {
    const allowlistEntries = [];
    const allowlistEntry = conformanceExemptionConfig.get(ruleCtr.RULE_NAME);
    if (allowlistEntry) {
      allowlistEntries.push(allowlistEntry);
    }
    return new ruleCtr(allowlistEntries);
  });

  // Register all rules.
  for (const rule of conformanceRules) {
    rule.register(conformanceChecker);
  }

  // Run all enabled conformance checks and collect errors.
  for (const sf of program.getSourceFiles()) {
    // We don't emit errors for delcarations, so might as well skip checking
    // declaration files all together.
    if (sf.isDeclarationFile) continue;
    const conformanceDiagErr = conformanceChecker.execute(sf).map(
        failure => failure.toDiagnosticWithStringifiedFixes());
    diagnostics.push(...conformanceDiagErr);
  }

  return diagnostics;
}

/**
 * A simple tsc wrapper that runs TSConformance checks over the source files
 * and emits code for files without conformance violations.
 */
function main(args: string[]) {
  if (isInBuildMode(args)) {
    // We don't support any of the build options, so we only expect one option
    // in build mode. It may make sense to support incremental build to save
    // time. The others are likely never relevant to tsec.
    const projects = args.slice(1);

    // Bail if there are more than one tsconfig.json (or unsupported options)
    // are provided.
    if (projects.length > 1) {
      return 1;
    }

    const buildHost = ts.createSolutionBuilderHost(
        ts.sys,
        /*createProgram*/ undefined,
        reportDiagnostic,
        /*reportSolutionBuilderStatus*/ undefined,
        reportErrorSummary,

    );

    const diagnostics: ts.Diagnostic[] = [];

    buildHost.afterProgramEmitAndDiagnostics = (p) => {
      diagnostics.push(...performanceConformanceCheck(p.getProgram()));
    };
    const builder =
        ts.createSolutionBuilder(buildHost, projects, /*buildOptions*/ {});

    // Force clean. The project may have been built by tsc before. To ensure we
    // can report conformance errors, we need to dump the build cache first.
    builder.clean();

    const exitStatus = builder.build();
    if (exitStatus !== ts.ExitStatus.Success) {
      ts.sys.write(
          'There are build errors in your project. Please make sure your project can be built by tsc');
      return 1;
    }

    const errorCount = reportDiagnosticsWithSummary(diagnostics);

    return errorCount === 0 ? 0 : 1;
  }

  let parsedConfig: ExtendedParsedCommandLine = ts.parseCommandLine(args);
  if (parsedConfig.errors.length !== 0) {
    // Same as tsc, do not emit colorful diagnostic texts for command line
    // parsing errors.
    ts.sys.write(
        ts.formatDiagnostics(parsedConfig.errors, FORMAT_DIAGNOSTIC_HOST));
    return 1;
  }

  // If no source files are specified through command line arguments, there
  // must be a configuration file that tells the compiler what to do. Try
  // looking for this file and parse it.
  if (parsedConfig.fileNames.length === 0) {
    const tsConfigFilePath = getTsConfigFilePath(parsedConfig.options.project);
    const parseConfigFileHost: ts.ParseConfigFileHost = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic: ts.Diagnostic) => {
        ts.sys.write(ts.formatDiagnostic(diagnostic, FORMAT_DIAGNOSTIC_HOST));
        ts.sys.exit(1);
      }
    };
    parsedConfig = parseTsConfigFile(
        tsConfigFilePath, parsedConfig.options, parseConfigFileHost);
  }

  const diagnostics = [...parsedConfig.errors];

  // Try locating and parsing exemption list.
  let conformanceExemptionConfig: ExemptionList = new Map();
  if (parsedConfig.conformanceExemptionPath) {
    const conformanceExemptionOrErrors =
        parseConformanceExemptionConfig(parsedConfig.conformanceExemptionPath);

    if (Array.isArray(conformanceExemptionOrErrors)) {
      diagnostics.push(...conformanceExemptionOrErrors);
    } else {
      conformanceExemptionConfig = conformanceExemptionOrErrors;
    }
  }

  const compilerHost = ts.createCompilerHost(parsedConfig.options, true);

  const program = ts.createProgram(
      parsedConfig.fileNames, parsedConfig.options, compilerHost);

  diagnostics.push(
      ...performanceConformanceCheck(program, conformanceExemptionConfig));

  // If there are conformance errors while noEmitOnError is set, refrain from
  // emitting code.
  if (diagnostics.length !== 0 && parsedConfig.options.noEmitOnError === true) {
    // We have to override this flag because conformance errors are not visible
    // to the actual compiler. Without `noEmit` being set, the compiler will
    // emit JS code if no other errors are found, even though we already know
    // there are conformance violations at this point.
    program.getCompilerOptions().noEmit = true;
  }

  const result = program.emit();
  diagnostics.push(...result.diagnostics);

  const errorCount = reportDiagnosticsWithSummary(diagnostics);

  return errorCount === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
