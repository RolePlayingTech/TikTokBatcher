import chalk from 'chalk';

export const log = {
  info: (msg: string) => console.log(chalk.cyan('[i]'), msg),
  ok: (msg: string) => console.log(chalk.green('[ok]'), msg),
  warn: (msg: string) => console.log(chalk.yellow('[!]'), msg),
  err: (msg: string) => console.log(chalk.red('[x]'), msg),
  step: (msg: string) => console.log(chalk.magenta('>'), msg),
  dim: (msg: string) => console.log(chalk.gray('  ' + msg)),
};
