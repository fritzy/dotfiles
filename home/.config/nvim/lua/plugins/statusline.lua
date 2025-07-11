return {
  'echasnovski/mini.statusline',
  version = false,
  opts = {
    content = {
      inactive = function()
        return '%#MiniStatuslineInactive# [%n] %F%='
      end,
    },
  },
}
