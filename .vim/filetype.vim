" my filetype file
if exists("did_load_filetypes")
  finish
endif
augroup filetypedetect
  au! BufRead,BufNewFile *.mlua     setfiletype lua
  au! BufRead,BufNewFile *.flua     setfiletype lua
  au! BufRead,BufNewFile *.mpp     setfiletype markdown
augroup END
