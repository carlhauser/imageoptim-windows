/* win32_compat.h
 *
 * compatibility stuff for Windows
 *
 * Thanks to Javier Gutiérrez Chamorro for Windows support.
 */

#ifndef WIN32_COMPAT_H
#define WIN32_COMPAT_H 1

#ifdef	__cplusplus
extern "C" {
#endif


#include <process.h>
#include <errno.h>
#include <io.h> /* _findfirst and _findnext set errno iff they return -1 */
#include <fcntl.h>
#include <sys/utime.h>

#define snprintf _snprintf
/* _stat is itself a macro on MinGW-w64, expanding to _stat64i32, which takes a
   struct _stat64i32 and not the struct stat that misc.c declares. Windows has no
   lstat, so aliasing it to plain stat keeps the types consistent and matches the
   behaviour this header already intended. */
#define lstat stat

#define realpath(N,R) _fullpath((R),(N),MAXPATHLEN)
#define ftruncate(fildes,length) open(fildes, O_TRUNC|O_WRONLY)

#define set_filemode_binary(file) _setmode(_fileno(file), _O_BINARY)

#define round(x) ((int) (x))
#define getuid(x) 0
#define geteuid() 0
#define chown(outfname,st_uid,st_gid) 0
#define S_ISREG(mode)  (((mode) & S_IFMT) == S_IFREG)
#define S_ISDIR(mode)  (((mode) & S_IFMT) == S_IFDIR)

#ifndef HOST_TYPE
#if _WIN64
#define HOST_TYPE "Win64"
#else if WIN32
#define HOST_TYPE "Win32"
#endif 
#endif


#ifdef	__cplusplus
}
#endif

#endif /* WIN32_COMPAT_H */
