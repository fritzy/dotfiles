syntax on

set nocompatible	" improved

" plugin stuff
filetype off	
call plug#begin('~/.config/vim-plugin')

Plug 'pangloss/vim-javascript'
"Plug 'flazz/vim-colorschemes'
Plug 'neoclide/coc.nvim', {'branch': 'release'}
Plug 'scrooloose/nerdtree'
Plug 'Xuyuanp/nerdtree-git-plugin'
Plug 'rafi/awesome-vim-colorschemes'

" for github plugin
" for telescope
Plug 'nvim-lua/popup.nvim'
Plug 'nvim-lua/plenary.nvim'
Plug 'nvim-telescope/telescope.nvim'

Plug 'kyazdani42/nvim-web-devicons'
Plug 'pwntester/octo.nvim'

Plug 'gelguy/wilder.nvim'

Plug 'mhinz/vim-startify'

call plug#end()
filetype plugin indent on

" theme stuff
set termguicolors
set background=dark
let ayucolor="mirage"
colorscheme jellybeans

set wildmenu

set bs=2
set sw=2
set softtabstop=2
set expandtab

set clipboard=unnamed

" show invisible
set list
set smartindent

" shortcuts
let mapleader = ","

" buffer navigation shortcuts
map <C-l> <C-W>l
map <C-h> <C-W>h
map <C-j> <C-w>j
map <C-k> <C-W>k
map ˜ <Leader>tn
map ¬ <Leader>tl
map ˙ <Leader>th

" tabs
vnoremap , <gv
vnoremap . >gv

" no, other tabs
nnoremap tj  :tabfirst<CR>
nnoremap tl  :tabnext<CR>
nnoremap th  :tabprev<CR>
nnoremap tk  :tablast<CR>
nnoremap tt  :tabedit<Space>
nnoremap tm  :tabm<Space>
nnoremap td  :tabclose<CR>
" Alternatively use
nnoremap tn :tabnew<CR>

" terminal esc
:tnoremap <Esc> <C-\><C-n>

function NumToggle()
    if &number
        setlocal nonumber
    else
        setlocal number
    endif
endfunction
nmap <S-n> mz:execute NumToggle()<CR>'z
nmap <Leader>gn mz:execute NumToggle()<CR>'z

function TwoSpaces()
  set sw=2
  set softtabstop=2
  set expandtab
  echo "tabs are 2 spaces"
endfunction

nmap <S-t> mz:execute TabToggle()<CR>'z
nmap <S-s> mz:execute TwoSpaces()<CR>'z

nnoremap <silent> <C-n> :NERDTreeToggle<CR>


map <leader>cd :cd %:p:h<cr>:pwd<cr>


" auto resize splits
nnoremap <Leader>= :wincmd =<CR>

nmap <C-e> :vertical resize +1<CR>
nmap <C-b> :vertical resize -1<CR>
nmap <S-e> :resize -1<CR>
nmap <S-b> :resize +1<CR>

"coc.nvim stuff

" Use tab for trigger completion with characters ahead and navigate.
" NOTE: Use command ':verbose imap <tab>' to make sure tab is not mapped by
" other plugin before putting this into your config.
inoremap <silent><expr> <TAB>
      \ pumvisible() ? "\<C-n>" :
      \ <SID>check_back_space() ? "\<TAB>" :
      \ coc#refresh()
inoremap <expr><S-TAB> pumvisible() ? "\<C-p>" : "\<C-h>"

function! s:check_back_space() abort
  let col = col('.') - 1
  return !col || getline('.')[col - 1]  =~# '\s'
endfunction

" Add `:Format` command to format current buffer.
command! -nargs=0 Format :call CocAction('format')


" Exit Vim if NERDTree is the only window remaining in the only tab.
autocmd BufEnter * if tabpagenr('$') == 1 && winnr('$') == 1 && exists('b:NERDTree') && b:NERDTree.isTabTree() | quit | endif

" Close the tab if NERDTree is the only window remaining in it.
autocmd BufEnter * if winnr('$') == 1 && exists('b:NERDTree') && b:NERDTree.isTabTree() | quit | endif

call wilder#enable_cmdline_enter()
set wildcharm=<Tab>
cmap <expr> <Tab> wilder#in_context() ? wilder#next() : "\<Tab>"
cmap <expr> <S-Tab> wilder#in_context() ? wilder#previous() : "\<S-Tab>"
call wilder#set_option('modes', ['/', '?', ':'])


" 'highlighter' : applies highlighting to the candidates
call wilder#set_option('renderer', wilder#popupmenu_renderer({
      \ 'highlighter': wilder#basic_highlighter(),
      \ }))

let g:startify_bookmarks = [ {'c': '~/.config/nvim/init.vim' }, {'n': '~/projects/npm/cli/' }]

